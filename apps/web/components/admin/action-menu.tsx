'use client';

import { useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ActionMenuItem {
  label: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Kẻ một đường phân cách phía trên mục này. */
  separated?: boolean;
}

/**
 * Nút "⋯" mở menu thao tác (popover tự viết — repo chưa có thư viện dropdown).
 * Bàn phím: Enter/Space/↓ mở và focus mục đầu, ↑/↓/Home/End di chuyển, Esc/Tab đóng; Esc trả focus về nút.
 */
export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last'>('first');
  const menuId = useId();

  const enabledItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );

  useEffect(() => {
    if (!open) return;
    const nodes = enabledItems();
    (focusOnOpen.current === 'last' ? nodes[nodes.length - 1] : nodes[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusOnOpen.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const nodes = enabledItems();
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = nodes[(index + 1) % nodes.length];
        break;
      case 'ArrowUp':
        next = nodes[(index - 1 + nodes.length) % nodes.length];
        break;
      case 'Home':
        next = nodes[0];
        break;
      case 'End':
        next = nodes[nodes.length - 1];
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    next?.focus();
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          focusOnOpen.current = 'first';
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <MoreHorizontal aria-hidden />
      </Button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-30 mt-1 flex w-52 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} role="none">
                {item.separated && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled}
                  onClick={() => {
                    close(false);
                    item.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50',
                    item.destructive &&
                      'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10',
                  )}
                >
                  {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
                  {item.label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
