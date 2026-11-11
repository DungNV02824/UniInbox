'use client';

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, X } from 'lucide-react';
import type { ContactTagDto } from '@dezon/shared';
import { TagChip } from '@/components/tag-chip';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  buildTagIndex,
  buildTagOptions,
  findCatalogTag,
  firstSelectableIndex,
  moveActiveIndex,
  shouldAutoAssignOnTag,
  tagKey,
  type TagOption,
} from '@/lib/contact-tags';
import { contactTagKeys, contactTagsApi, useContactTags } from '@/lib/contact-tags-api';
import { errorText, useUpdateContact, useUpdateConversation } from '@/lib/inbox-queries';
import { tagSwatchClass } from '@/lib/tag-colors';
import { cn } from '@/lib/utils';

const TAGS_MAX = 30;
const LEGACY_TITLE = 'Nhãn chưa có trong danh sách';

/**
 * Nhãn của khách: chọn từ danh sách nhãn (ô gõ để lọc), xóa bằng × trên chip.
 * Gắn nhãn cho hội thoại chưa phân công ⇒ tự giao cho người gắn.
 */
export function ContactTagsEditor({
  conversationId,
  contactId,
  tags,
  assignedUserId,
}: {
  conversationId: string;
  contactId: string;
  tags: string[];
  /** Người đang phụ trách hội thoại; null = chưa phân công. */
  assignedUserId?: string | null;
}) {
  const update = useUpdateContact(conversationId, contactId);
  const assign = useUpdateConversation(conversationId);
  const catalogQuery = useContactTags();
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const index = useMemo(() => buildTagIndex(catalog), [catalog]);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const qc = useQueryClient();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState<string | null>(null);

  // Lạc quan: đang lưu thì hiện danh sách vừa gửi.
  const shown = update.isPending && update.variables?.tags ? update.variables.tags : tags;
  const options = useMemo(
    () => buildTagOptions(catalog, query, shown, isAdmin),
    [catalog, query, shown, isAdmin],
  );
  const activeIndex = active >= 0 && active < options.length ? active : firstSelectableIndex(options);

  function saveTags(next: string[]) {
    const autoAssign = !!user && shouldAutoAssignOnTag(shown, next, assignedUserId);
    update.mutate(
      { tags: next },
      {
        onSuccess: () => {
          // Số khách trên trang quản trị đổi: đánh dấu cũ, không tải lại ngay.
          void qc.invalidateQueries({ queryKey: contactTagKeys.all, refetchType: 'none' });
          if (autoAssign && user && !assign.isPending) assign.mutate({ assignedUserId: user.id });
        },
      },
    );
  }

  function addName(name: string) {
    setError(null);
    if (shown.some((t) => tagKey(t) === tagKey(name))) return;
    if (shown.length >= TAGS_MAX) return setError(`Tối đa ${TAGS_MAX} nhãn.`);
    saveTags([...shown, name]);
    setQuery('');
    setActive(-1);
  }

  const create = useMutation({
    mutationFn: (name: string) => contactTagsApi.create({ name, color: 'blue' }),
    onSuccess: (tag) => {
      qc.setQueryData<ContactTagDto[]>(contactTagKeys.all, (old) =>
        old && !old.some((t) => t.id === tag.id) ? [...old, tag] : old,
      );
      void qc.invalidateQueries({ queryKey: contactTagKeys.all });
      addName(tag.name);
    },
    onError: (err, name) => {
      // Vừa có người tạo trùng: nhãn đã có trong danh sách ⇒ gắn luôn.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: contactTagKeys.all });
        addName(name);
        return;
      }
      setError(errorText(err, 'Không tạo được nhãn.'));
    },
  });

  function choose(option: TagOption | undefined) {
    if (!option || option.kind === 'hint') return;
    if (option.kind === 'tag') addName(option.tag.name);
    else if (!create.isPending) create.mutate(option.name);
    inputRef.current?.focus();
  }

  function remove(tag: string) {
    setError(null);
    saveTags(shown.filter((t) => t !== tag));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive(moveActiveIndex(options, activeIndex, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) choose(options[activeIndex]);
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (query) {
        e.preventDefault();
        setQuery('');
      }
    }
  }

  const busy = update.isPending || create.isPending;
  const showList = open && (options.length > 0 || catalogQuery.isPending);
  const activeId = showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined;

  return (
    <div className="flex flex-col gap-2">
      {shown.length > 0 && (
        <ul className="flex flex-wrap gap-x-1.5 gap-y-2" aria-label="Nhãn của khách">
          {shown.map((name) => {
            const tag = findCatalogTag(index, name);
            // Danh sách chưa tải xong thì chưa coi là nhãn cũ.
            const legacy = !tag && catalogQuery.isSuccess;
            return (
              <li key={name} className="max-w-full">
                <TagChip
                  name={tag?.name ?? name}
                  color={tag ? tag.color : legacy ? null : 'gray'}
                  title={legacy ? LEGACY_TITLE : undefined}
                  className="pr-1"
                >
                  {/* Vùng bấm ≥32px cho điện thoại (lớp ::before), nút nhìn vẫn nhỏ gọn. */}
                  <button
                    type="button"
                    onClick={() => remove(name)}
                    disabled={busy}
                    className="relative shrink-0 rounded-full p-0.5 opacity-70 before:absolute before:top-1/2 before:left-1/2 before:size-8 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:bg-background/60 hover:opacity-100"
                    aria-label={`Xóa nhãn ${name}`}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </TagChip>
              </li>
            );
          })}
        </ul>
      )}
      <div className="relative">
        <Input
          ref={inputRef}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="Thêm nhãn"
          value={query}
          maxLength={60}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
            setOpen(true);
            setError(null);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={catalog.length || isAdmin ? 'Chọn hoặc gõ để tìm nhãn...' : 'Chưa có nhãn nào'}
          className="h-8 pr-8"
        />
        {busy && (
          <Loader2
            className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
        {showList && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Nhãn có thể gắn"
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {catalogQuery.isPending && options.length === 0 && (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">Đang tải danh sách nhãn...</li>
            )}
            {options.map((option, i) => {
              const id = `${listId}-${i}`;
              if (option.kind === 'hint') {
                return (
                  <li
                    key="hint"
                    id={id}
                    role="option"
                    aria-selected={false}
                    aria-disabled
                    className="px-2 py-1.5 text-xs text-muted-foreground"
                  >
                    {option.text}
                  </li>
                );
              }
              const selected = i === activeIndex;
              return (
                <li
                  key={option.kind === 'tag' ? option.tag.id : 'create'}
                  id={id}
                  role="option"
                  aria-selected={selected}
                  // Giữ focus ở ô nhập (blur sẽ đóng danh sách trước khi click kịp chạy).
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(option)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                    selected && 'bg-accent text-accent-foreground',
                  )}
                >
                  {option.kind === 'tag' ? (
                    <>
                      <span
                        className={cn('size-2.5 shrink-0 rounded-full', tagSwatchClass(option.tag.color))}
                        aria-hidden
                      />
                      <span className="truncate">{option.tag.name}</span>
                    </>
                  ) : (
                    <>
                      <Plus className="size-3.5 shrink-0 text-brand" aria-hidden />
                      <span className="truncate">
                        Tạo nhãn &ldquo;<strong className="font-medium">{option.name}</strong>&rdquo;
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {catalogQuery.isError && (
        <p className="text-xs text-destructive">
          {errorText(catalogQuery.error, 'Không tải được danh sách nhãn.')}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
