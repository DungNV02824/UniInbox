'use client';

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Check, Loader2, Pencil } from 'lucide-react';
import {
  CAPTURE_BUILTIN_LABELS,
  CAPTURE_LIMITS,
  type CaptureFieldRef,
  type ContactDetail,
  type UpdateContactRequest,
} from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AI_FIELD_TOOLTIP, contactNoteFields, phoneUpdate, profileFieldUpdate } from '@/lib/contact-profile';
import { useUpdateContact } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';

const NAME_MAX = 200;
const NOTES_MAX = 5000;

interface EditorProps {
  conversationId: string;
  contactId: string;
}

/** Tên khách: bấm bút chì để sửa; Enter/blur lưu, Esc hủy. */
export function ContactNameEditor({ conversationId, contactId, name }: EditorProps & { name: string }) {
  const update = useUpdateContact(conversationId, contactId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  function start() {
    setValue(name);
    setEditing(true);
  }

  function save() {
    const next = value.trim();
    setEditing(false);
    if (!next || next === name || next.length > NAME_MAX) return;
    update.mutate({ displayName: next });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        maxLength={NAME_MAX}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={onKeyDown}
        aria-label="Tên khách hàng"
        className="h-8 text-center"
      />
    );
  }
  return (
    <div className="flex max-w-full items-center gap-1">
      <span className="truncate font-semibold">
        {update.isPending ? update.variables?.displayName : name}
      </span>
      <Button variant="ghost" size="icon" className="size-7" onClick={start} aria-label="Sửa tên khách">
        {update.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}
      </Button>
    </div>
  );
}

/** Dấu "AI" nhỏ cạnh trường bot tự điền. */
function AiBadge() {
  return (
    <span
      title={AI_FIELD_TOOLTIP}
      className="inline-flex cursor-help items-center rounded bg-muted px-1 text-[10px] leading-4 font-semibold text-muted-foreground"
    >
      AI<span className="sr-only"> — {AI_FIELD_TOOLTIP}</span>
    </span>
  );
}

/**
 * Một ô thông tin khách (SĐT, Nhu cầu, trường bot thu thập, Ghi chú khác): lưu khi rời ô / Enter (ô một dòng)
 * / bấm Lưu; Esc hủy. Chỉ khi nhân viên ĐÃ GÕ mới có bản nháp — bản nháp thắng bản mới từ máy chủ (bot vừa điền,
 * người khác sửa) khi ô đang focus. Chỉ focus rồi rời ô (không gõ) ⇒ không gửi gì, ô luôn hiện giá trị máy chủ.
 * Lưu xong ⇒ bỏ bản nháp, hiện giá trị máy chủ đã chuẩn hóa (SĐT dạng chuẩn, đã trim).
 */
export function ContactFieldEditor({
  conversationId,
  contactId,
  label,
  value: savedValue,
  toBody,
  multiline = true,
  type = 'text',
  maxLength,
  placeholder,
  aiFilled = false,
  className,
}: EditorProps & {
  label: string;
  value: string | null;
  toBody: (value: string) => UpdateContactRequest;
  multiline?: boolean;
  type?: 'text' | 'tel';
  maxLength: number;
  placeholder?: string;
  /** Giá trị hiện tại do bot điền ⇒ hiện dấu "AI". */
  aiFilled?: boolean;
  className?: string;
}) {
  const update = useUpdateContact(conversationId, contactId);
  const id = useId();
  const saved = savedValue ?? '';
  // null = nhân viên chưa gõ gì ⇒ hiện giá trị máy chủ.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const focusedRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dirty = draft !== null && draft !== saved;

  // Bot điền / người khác sửa: bỏ bản nháp nếu mình không đang gõ.
  useEffect(() => {
    if (!focusedRef.current) setDraft(null);
  }, [saved]);

  function save() {
    if (draft === null || update.isPending) return;
    if (!dirty) {
      setDraft(null);
      return;
    }
    if (draft.length > maxLength) return;
    const sent = draft;
    update.mutate(toBody(sent), {
      // Máy chủ có thể chuẩn hóa (SĐT, trim) ⇒ bỏ bản nháp để hiện giá trị đã lưu; gõ thêm trong lúc lưu thì giữ.
      onSuccess: () => setDraft((d) => (d === sent ? null : d)),
    });
  }

  function cancel() {
    setDraft(null);
  }

  const common = {
    id,
    value,
    maxLength,
    placeholder,
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      focusedRef.current = false;
      // Rời ô để bấm "Hủy" (chuột hoặc Tab): không được lưu.
      if (e.relatedTarget === cancelRef.current) return;
      save();
    },
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex min-h-5 items-center gap-1.5">
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {aiFilled && !dirty && <AiBadge />}
      </div>
      {multiline ? (
        <Textarea
          {...common}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && dirty) {
              e.preventDefault();
              cancel();
            }
          }}
          rows={2}
          className="min-h-14 resize-y"
        />
      ) : (
        <Input
          {...common}
          type={type}
          inputMode={type === 'tel' ? 'tel' : undefined}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape' && dirty) {
              e.preventDefault();
              cancel();
            }
          }}
          className="h-8"
        />
      )}
      {(dirty || update.isPending) && (
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {update.isPending ? 'Đang lưu...' : 'Chưa lưu'}
          </span>
          <Button
            ref={cancelRef}
            variant="ghost"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
            disabled={update.isPending}
          >
            Hủy
          </Button>
          <Button
            size="sm"
            variant="brand"
            onMouseDown={(e) => e.preventDefault()}
            onClick={save}
            disabled={update.isPending}
          >
            {update.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
            Lưu
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Mục "Ghi chú" của khách: SĐT, Nhu cầu, các trường bot thu thập / nhân viên điền, rồi Ghi chú khác (tự do).
 * Mỗi ô lưu riêng qua PATCH /contacts/:id.
 */
export function ContactNotesFields({
  conversationId,
  contactId,
  contact,
  captureFields,
}: EditorProps & {
  contact: ContactDetail;
  /** Trường thu thập của bot đang gắn (ChatbotRef.captureFields) — hiện sẵn kể cả khi AI chưa điền. */
  captureFields?: readonly CaptureFieldRef[] | null;
}) {
  const { need, others } = contactNoteFields(contact, captureFields);
  const ids = { conversationId, contactId };
  return (
    <div className="flex flex-col gap-3">
      <ContactFieldEditor
        {...ids}
        label={CAPTURE_BUILTIN_LABELS.phone}
        value={contact.phone}
        toBody={phoneUpdate}
        multiline={false}
        type="tel"
        maxLength={CAPTURE_LIMITS.phoneMax}
        placeholder="Số điện thoại của khách"
        aiFilled={contact.phoneSource === 'ai' && !!contact.phone}
      />
      <ContactFieldEditor
        {...ids}
        label={need.label}
        value={need.value}
        toBody={(v) => profileFieldUpdate(need, v)}
        maxLength={CAPTURE_LIMITS.valueMax}
        placeholder="Khách cần gì, quy mô, khu vực..."
        aiFilled={need.source === 'ai' && !!need.value}
      />
      {others.map((f) => (
        <ContactFieldEditor
          key={f.key}
          {...ids}
          label={f.label}
          value={f.value}
          toBody={(v) => profileFieldUpdate(f, v)}
          maxLength={CAPTURE_LIMITS.valueMax}
          placeholder="Chưa có"
          aiFilled={f.source === 'ai' && !!f.value}
        />
      ))}
      <ContactFieldEditor
        {...ids}
        label="Ghi chú khác"
        value={contact.notes}
        toBody={(v) => ({ notes: v.trim() ? v : null })}
        maxLength={NOTES_MAX}
        placeholder="Ghi chú về khách (chỉ nhân viên thấy)..."
        className="[&_textarea]:min-h-20"
      />
    </div>
  );
}

export { ContactTagsEditor } from './contact-tags-editor';
