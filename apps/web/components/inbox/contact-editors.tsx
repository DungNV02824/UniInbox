'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateContact } from '@/lib/inbox-queries';

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

/** Ghi chú nội bộ về khách: lưu khi rời ô hoặc bấm Lưu. */
export function ContactNotesEditor({
  conversationId,
  contactId,
  notes,
}: EditorProps & { notes: string | null }) {
  const update = useUpdateContact(conversationId, contactId);
  const saved = notes ?? '';
  const [value, setValue] = useState(saved);
  const focusedRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dirty = value !== saved;

  // Người khác sửa ghi chú: cập nhật nếu mình không đang gõ.
  useEffect(() => {
    if (!focusedRef.current) setValue(saved);
  }, [saved]);

  function save() {
    if (!dirty || value.length > NOTES_MAX) return;
    update.mutate({ notes: value.trim() ? value : null });
  }

  function cancel() {
    setValue(saved);
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={value}
        maxLength={NOTES_MAX}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          // Rời ô để bấm "Hủy" (chuột hoặc Tab): không được lưu.
          if (e.relatedTarget === cancelRef.current) return;
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && dirty) {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder="Ghi chú về khách (chỉ nhân viên thấy)..."
        aria-label="Ghi chú"
        className="min-h-24 resize-y"
      />
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

export { ContactTagsEditor } from './contact-tags-editor';
