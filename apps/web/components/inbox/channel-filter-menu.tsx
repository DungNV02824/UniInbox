'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Layers } from 'lucide-react';
import type { ConversationFilters } from '@/lib/inbox-api';
import { safeColor } from '@/lib/inbox-format';
import { cn } from '@/lib/utils';
import {
  channelFilterFor,
  channelFilterOptions,
  channelOptionLabel,
  groupChannelsForFilter,
  isChannelActive,
  selectedChannelKey,
  type ChannelFilterChannel,
  type ChannelFilterOption,
} from './list-filters';
import { useDismiss } from './use-dismiss';

type ChannelFilter = Pick<ConversationFilters, 'channelType' | 'channelAccountId'>;

const INACTIVE_DOT = '#a1a1aa';

function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

function channelDotColor(ch: ChannelFilterChannel) {
  return isChannelActive(ch) ? safeColor(ch.color) : INACTIVE_DOT;
}

/**
 * Menu chọn kênh dạng listbox (thay hàng chip kênh): "Tất cả kênh", rồi theo nền tảng
 * (Facebook, Zalo OA, Zalo cá nhân) từng Trang/tài khoản kèm chấm màu. Điều hướng bằng phím mũi tên,
 * Home/End, Enter/Space để chọn, Esc để đóng.
 */
export function ChannelFilterMenu({
  channels,
  value,
  onChange,
  loading,
}: {
  channels: readonly ChannelFilterChannel[];
  value: ChannelFilter;
  onChange: (next: ChannelFilter) => void;
  loading?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupChannelsForFilter(channels), [channels]);
  const options = useMemo(() => channelFilterOptions(groups), [groups]);
  const selectedKey = selectedChannelKey(value);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.key === selectedKey),
  );
  const selected = options[selectedIndex];
  const selectedChannel = value.channelAccountId
    ? channels.find((c) => c.id === value.channelAccountId)
    : undefined;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  useDismiss(open, close, [triggerRef, listRef]);

  const openMenu = (index = selectedIndex) => {
    setActiveIndex(index);
    setOpen(true);
  };

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // Giữ mục đang sáng trong vùng nhìn thấy khi di chuyển bằng phím.
  useEffect(() => {
    if (!open) return;
    // Tự cuộn trong listbox (không dùng scrollIntoView để không cuộn các khung cha).
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    }
  }, [open, activeIndex]);

  const choose = (option: ChannelFilterOption) => {
    onChange(channelFilterFor(option));
    close(true);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu();
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => Math.min(last, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(last);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const option = options[activeIndex];
        if (option) choose(option);
        break;
      }
      case 'Tab':
        close(false);
        break;
    }
  };

  // Nhãn trên nút: kênh đang chọn (kể cả khi danh sách kênh chưa tải xong).
  let label = 'Tất cả kênh';
  let dot: string | null = null;
  if (value.channelAccountId) {
    label = selectedChannel
      ? channelOptionLabel(selectedChannel)
      : loading
        ? 'Đang tải kênh...'
        : 'Kênh đã chọn';
    dot = selectedChannel ? channelDotColor(selectedChannel) : null;
  } else if (selected?.kind === 'type') {
    label = `Tất cả ${selected.label}`;
  }

  const optionId = (index: number) => `${id}-opt-${index}`;
  const renderOption = (option: ChannelFilterOption) => {
    const i = options.indexOf(option);
    const isSelected = option.key === selectedKey;
    const isActive = i === activeIndex;
    const common = {
      id: optionId(i),
      role: 'option' as const,
      'aria-selected': isSelected,
      'data-index': i,
      onMouseMove: () => setActiveIndex(i),
      onClick: () => choose(option),
    };
    const check = isSelected ? (
      <Check className="ml-auto size-3.5 shrink-0 text-brand" aria-hidden />
    ) : (
      <span className="ml-auto size-3.5 shrink-0" aria-hidden />
    );
    const base = 'flex cursor-pointer items-center gap-2 rounded-md px-2 text-[13px]';
    if (option.kind === 'all') {
      return (
        <div key={option.key} {...common} className={cn(base, 'h-8', isActive && 'bg-accent')}>
          <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn(isSelected && 'font-medium')}>Tất cả kênh</span>
          {check}
        </div>
      );
    }
    if (option.kind === 'type') {
      return (
        <div
          key={option.key}
          {...common}
          aria-label={`Tất cả ${option.label} (${option.count})`}
          className={cn(
            base,
            'mt-1 h-7 text-xs font-semibold text-muted-foreground',
            isActive && 'bg-accent',
          )}
        >
          <span className={cn(isSelected && 'text-brand')}>{option.label}</span>
          <span className="font-normal">({option.count})</span>
          {check}
        </div>
      );
    }
    const ch = option.channel;
    const active = isChannelActive(ch);
    return (
      <div
        key={option.key}
        {...common}
        title={channelOptionLabel(ch)}
        className={cn(base, 'h-8 pl-4', isActive && 'bg-accent', !active && 'text-muted-foreground')}
      >
        <Dot color={channelDotColor(ch)} />
        <span className={cn('min-w-0 truncate', isSelected && 'font-medium')}>{channelOptionLabel(ch)}</span>
        {check}
      </div>
    );
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Lọc theo kênh: ${label}`}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 text-left text-[13px] shadow-xs outline-none transition-[color,box-shadow] hover:bg-accent/60',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          open && 'border-ring',
        )}
      >
        {dot ? (
          <Dot color={dot} />
        ) : (
          <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            value.channelAccountId || value.channelType ? 'font-medium' : '',
          )}
        >
          {label}
        </span>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label="Chọn kênh"
          aria-activedescendant={optionId(activeIndex)}
          onKeyDown={onListKeyDown}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-[min(60dvh,360px)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
        >
          {renderOption(options[0]!)}
          {groups.map((g) => (
            <div key={g.type} role="group" aria-label={g.label}>
              {options
                .filter(
                  (o) =>
                    (o.kind === 'type' && o.type === g.type) ||
                    (o.kind === 'account' && o.channel.type === g.type),
                )
                .map(renderOption)}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {loading ? 'Đang tải kênh...' : 'Chưa kết nối kênh nào.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
