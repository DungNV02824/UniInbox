'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Loader2, Pencil, Trash2, Users } from 'lucide-react';
import type { ContactTagDto, TagColor, UpdateContactTagRequest } from '@dezon/shared';
import { TagChip } from '@/components/tag-chip';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { formatCount } from '@/lib/channels-admin';
import { TAG_NAME_MAX, tagUsageText, validateTagName } from '@/lib/contact-tags';
import { contactTagKeys, contactTagsApi } from '@/lib/contact-tags-api';
import { inboxKeys } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { TagColorPicker } from './tag-color-picker';

function TagEditForm({
  tag,
  catalog,
  onDone,
}: {
  tag: ContactTagDto;
  catalog: ContactTagDto[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<TagColor>(tag.color);
  const [error, setError] = useState<string | null>(null);
  const errorId = `tag-edit-error-${tag.id}`;

  const save = useMutation({
    mutationFn: (body: UpdateContactTagRequest) => contactTagsApi.update(tag.id, body),
    onSuccess: (updated, body) => {
      qc.setQueryData<ContactTagDto[]>(contactTagKeys.all, (old) =>
        old?.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)),
      );
      void qc.invalidateQueries({ queryKey: contactTagKeys.all });
      // Đổi tên áp cho khách ⇒ hồ sơ khách đang mở cần tải lại.
      if (body.name !== undefined) void qc.invalidateQueries({ queryKey: inboxKeys.details() });
      toast({ title: `Đã lưu nhãn "${updated.name}"`, variant: 'success' });
      onDone();
    },
    onError: (err) => setError(errorText(err, 'Không lưu được nhãn.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (save.isPending) return;
    const clean = name.trim();
    const invalid = validateTagName(clean, catalog, tag.id);
    if (invalid) return setError(invalid);
    const body: UpdateContactTagRequest = {};
    if (clean !== tag.name) body.name = clean;
    if (color !== tag.color) body.color = color;
    if (body.name === undefined && body.color === undefined) return onDone();
    save.mutate(body);
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 px-4 py-3 sm:px-5"
      aria-label={`Sửa nhãn ${tag.name}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={name}
          maxLength={TAG_NAME_MAX}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onDone();
            }
          }}
          aria-label="Tên nhãn"
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="h-8 min-w-48 flex-1"
        />
        {name.trim() && <TagChip name={name.trim()} color={color} className="max-w-60" />}
      </div>
      <TagColorPicker value={color} onChange={setColor} label={`Màu nhãn ${tag.name}`} />
      {name.trim() !== tag.name && tag.contactCount > 0 && !error && (
        <p className="text-xs text-muted-foreground">
          Đổi tên sẽ cập nhật cho {formatCount(tag.contactCount)} khách đang có nhãn này.
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="brand" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
          Lưu
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Hủy
        </Button>
      </div>
    </form>
  );
}

export function TagRow({
  tag,
  catalog,
  isFirst,
  isLast,
  reordering,
  onMove,
  onDelete,
}: {
  tag: ContactTagDto;
  catalog: ContactTagDto[];
  isFirst: boolean;
  isLast: boolean;
  reordering: boolean;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="bg-muted/30">
        <TagEditForm tag={tag} catalog={catalog} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2 px-2 py-2 sm:gap-3 sm:px-3">
      <div className="flex shrink-0 flex-col" role="group" aria-label={`Thứ tự nhãn ${tag.name}`}>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={isFirst || reordering}
          onClick={() => onMove(-1)}
          aria-label={`Đưa nhãn ${tag.name} lên trên`}
        >
          <ArrowUp className="size-3.5" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={isLast || reordering}
          onClick={() => onMove(1)}
          aria-label={`Đưa nhãn ${tag.name} xuống dưới`}
        >
          <ArrowDown className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <TagChip name={tag.name} color={tag.color} className="w-fit text-sm" />
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3.5 shrink-0" aria-hidden />
          {tagUsageText(tag.contactCount)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          aria-label={`Sửa nhãn ${tag.name}`}
        >
          <Pencil aria-hidden />
          <span className="hidden sm:inline">Sửa</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Xóa nhãn ${tag.name}`}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function DeleteTagDialog({ tag, onClose }: { tag: ContactTagDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => contactTagsApi.remove(tag.id),
    onSuccess: (res) => {
      qc.setQueryData<ContactTagDto[]>(contactTagKeys.all, (old) => old?.filter((t) => t.id !== tag.id));
      void qc.invalidateQueries({ queryKey: contactTagKeys.all });
      void qc.invalidateQueries({ queryKey: inboxKeys.details() });
      const removed = res?.removedFromContacts ?? 0;
      toast({
        title: `Đã xóa nhãn "${tag.name}"`,
        description: removed > 0 ? `Đã gỡ khỏi ${formatCount(removed)} khách.` : undefined,
        variant: 'success',
      });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !mutation.isPending && onClose()}
      title={`Xóa nhãn "${tag.name}"?`}
      description="Không thể hoàn tác."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Hủy
          </Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            Xóa nhãn
          </Button>
        </>
      }
    >
      <p className="text-sm">
        {tag.contactCount > 0 ? (
          <>
            <strong>{formatCount(tag.contactCount)} khách</strong> đang có nhãn này sẽ bị gỡ nhãn.
          </>
        ) : (
          'Chưa có khách nào mang nhãn này.'
        )}
      </p>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(mutation.error, 'Không xóa được nhãn.')}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}
