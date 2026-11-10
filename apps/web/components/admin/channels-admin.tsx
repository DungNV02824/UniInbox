'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  History,
  MessagesSquare,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  Trash2,
  Unplug,
  UserRound,
} from 'lucide-react';
import type { ChannelAccountDto } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { API_URL } from '@/lib/api';
import {
  canDeleteChannel,
  connectedByText,
  formatChannelStats,
  formatDate,
  splitChannels,
  summarizeChannels,
  summaryParts,
  type SummaryPart,
} from '@/lib/channels-admin';
import { safeColor } from '@/lib/inbox-format';
import { errorText, useChannels } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';
import { ActionMenu, type ActionMenuItem } from './action-menu';
import { ChannelChatbotSelect } from './channel-chatbot-select';
import {
  ConnectMessengerDialog,
  DeleteChannelDialog,
  DisconnectChannelDialog,
  EditChannelDialog,
} from './channel-dialogs';
import { ChannelStatusBadge, PlatformBadge } from './channel-status';
import { ChannelSyncStatus, SyncHistoryDialog } from './channel-sync';
import { ConnectMenu, FacebookPagesDialog, useFacebookReturn, useStartFacebookLogin } from './facebook-login';

const API_BASE = API_URL.replace(/\/+$/, '');
export const MESSENGER_WEBHOOK_URL = `${API_BASE}/webhooks/messenger`;
export const FACEBOOK_OAUTH_REDIRECT_URI = `${API_BASE}/channels/messenger/oauth/callback`;

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return [copied, copy] as const;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, copy] = useCopy();
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => copy(value)} aria-label={label}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Đã chép' : 'Chép'}
    </Button>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs">
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** "Page ID 1535…" + nút chép nhỏ. */
function ExternalId({ channel: ch }: { channel: ChannelAccountDto }) {
  const [copied, copy] = useCopy();
  const label = ch.type === 'messenger' ? 'Page ID' : 'ID';
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <span className="truncate font-mono text-foreground/70">{ch.externalId}</span>
      <button
        type="button"
        onClick={() => copy(ch.externalId)}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-label={copied ? `Đã chép ${label}` : `Chép ${label} ${ch.externalId}`}
        title={copied ? 'Đã chép' : `Chép ${label}`}
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-600" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </span>
  );
}

/** Ảnh Page (hoặc chữ cái đầu) với vòng màu nhãn của kênh. */
function ChannelAvatar({
  channel: ch,
  className,
  muted,
}: {
  channel: ChannelAccountDto;
  className?: string;
  muted?: boolean;
}) {
  const color = safeColor(ch.color);
  // Không có ảnh: chữ cái đầu trên nền màu nhãn; có ảnh: nền trắng (logo PNG trong suốt).
  const hasPicture = !!ch.pictureUrl;
  return (
    <span
      className={cn('inline-flex shrink-0 rounded-full', muted && 'opacity-60 grayscale')}
      style={{
        backgroundColor: hasPicture ? '#fff' : color,
        boxShadow: `0 0 0 2px var(--background), 0 0 0 4px ${color}`,
      }}
      title="Màu nhãn của kênh"
    >
      <Avatar
        src={ch.pictureUrl}
        name={ch.displayName}
        className={cn(
          'bg-transparent text-base font-semibold',
          hasPicture ? 'text-muted-foreground' : 'text-white',
          className,
        )}
      />
    </span>
  );
}

function InfoRow({ icon: Icon, children }: { icon: typeof UserRound; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-px size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

interface ChannelActions {
  onEdit: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onSync: () => void;
  onDelete: () => void;
}

function ChannelCard({ channel: ch, actions }: { channel: ChannelAccountDto; actions: ChannelActions }) {
  const broken = ch.status === 'expired' || ch.status === 'error';
  const isMessenger = ch.type === 'messenger';
  const by = connectedByText(ch);
  const stats = formatChannelStats(ch.stats);
  const running = !!ch.sync?.backfillRunning;

  const menu: ActionMenuItem[] = [
    { label: 'Sửa tên và màu', icon: Pencil, onSelect: actions.onEdit },
    {
      label: 'Ngắt kết nối',
      icon: Unplug,
      onSelect: actions.onDisconnect,
      destructive: true,
      separated: true,
    },
  ];
  if (canDeleteChannel(ch)) {
    menu.push({ label: 'Xóa kênh', icon: Trash2, onSelect: actions.onDelete, destructive: true });
  }

  return (
    <li
      className={cn(
        'flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-xs transition-shadow hover:shadow-sm',
        broken && 'border-red-200 dark:border-red-900/60',
      )}
    >
      <div className="flex items-start gap-3.5 p-4 pb-3">
        <ChannelAvatar channel={ch} className="size-11" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {/* Dưới sm: viên trạng thái xuống dòng dưới tên, tên được xuống 2 dòng thay vì bị cắt. */}
          <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:gap-2">
            <h3
              className="line-clamp-2 w-full min-w-0 leading-snug font-semibold break-words sm:line-clamp-1 sm:w-auto sm:flex-1"
              title={ch.displayName}
            >
              {ch.displayName}
            </h3>
            <ChannelStatusBadge status={ch.status} detail={ch.lastError} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <PlatformBadge type={ch.type} />
            <ExternalId channel={ch} />
          </div>
        </div>
      </div>

      {broken && (
        <div className="mx-4 mb-3 flex gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">
              {ch.status === 'expired'
                ? 'Token hết hạn hoặc mất quyền trên Trang. Kết nối lại để tiếp tục nhận tin.'
                : 'Kênh đang gặp lỗi, tạm ngừng nhận và gửi tin.'}
            </span>
            {ch.lastError && <span className="break-words opacity-80">{ch.lastError}</span>}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5 border-t px-4 py-3 text-xs text-muted-foreground">
        {by && <InfoRow icon={UserRound}>{by}</InfoRow>}
        {stats && <InfoRow icon={MessagesSquare}>{stats}</InfoRow>}
        {isMessenger && ch.status === 'connected' && ch.sync && <ChannelSyncStatus channel={ch} />}
        <ChannelChatbotSelect channel={ch} />
      </div>

      <div className="mt-auto flex items-center gap-2 rounded-b-xl border-t bg-muted/30 px-3 py-2">
        {isMessenger && ch.status === 'connected' && (
          <Button
            variant="outline"
            size="sm"
            onClick={actions.onSync}
            disabled={running}
            title={running ? 'Đang đồng bộ, vui lòng chờ' : undefined}
          >
            <History aria-hidden />
            {running ? 'Đang đồng bộ…' : 'Đồng bộ lịch sử'}
          </Button>
        )}
        {isMessenger && broken && (
          <Button variant="brand" size="sm" onClick={actions.onReconnect}>
            <PlugZap aria-hidden />
            Kết nối lại
          </Button>
        )}
        <div className="ml-auto">
          <ActionMenu label={`Thao tác khác cho kênh ${ch.displayName}`} items={menu} />
        </div>
      </div>
    </li>
  );
}

function DisconnectedRow({ channel: ch, actions }: { channel: ChannelAccountDto; actions: ChannelActions }) {
  const stats = formatChannelStats(ch.stats);
  const date = formatDate(ch.updatedAt);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <ChannelAvatar channel={ch} className="size-9 text-sm" muted />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground/70" title={ch.displayName}>
          {ch.displayName}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <ExternalId channel={ch} />
          {date && <span>Ngắt ngày {date}</span>}
          {stats && <span>{stats}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {ch.type === 'messenger' && (
          <Button
            variant="outline"
            size="sm"
            onClick={actions.onReconnect}
            aria-label={`Kết nối lại kênh ${ch.displayName}`}
          >
            <PlugZap aria-hidden />
            <span className="hidden sm:inline">Kết nối lại</span>
          </Button>
        )}
        <ActionMenu
          label={`Thao tác khác cho kênh ${ch.displayName}`}
          items={[
            { label: 'Sửa tên và màu', icon: Pencil, onSelect: actions.onEdit },
            {
              label: 'Xóa kênh',
              icon: Trash2,
              onSelect: actions.onDelete,
              destructive: true,
              separated: true,
            },
          ]}
        />
      </div>
    </li>
  );
}

function DisconnectedSection({
  channels,
  actionsFor,
}: {
  channels: ChannelAccountDto[];
  actionsFor: (ch: ChannelAccountDto) => ChannelActions;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section className="flex flex-col gap-3" aria-label="Kênh đã ngắt kết nối">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="group flex w-fit items-center gap-1.5 rounded-md py-1 pr-2 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} aria-hidden />
        Kênh đã ngắt kết nối ({channels.length})
      </button>
      {open && (
        <div id={listId} className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Kênh đã ngắt không nhận hay gửi tin, lịch sử hội thoại vẫn được giữ. Kết nối lại để dùng tiếp,
            hoặc xóa hẳn kênh không cần nữa.
          </p>
          <ul className="divide-y rounded-xl border bg-card shadow-xs">
            {channels.map((ch) => (
              <DisconnectedRow key={ch.id} channel={ch} actions={actionsFor(ch)} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const TONE_DOT: Record<SummaryPart['tone'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-red-500',
  muted: 'bg-slate-400',
};

function SummaryLine({ channels }: { channels: ChannelAccountDto[] }) {
  const parts = summaryParts(summarizeChannels(channels));
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {parts.map((p) => (
        <span key={p.tone} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2 rounded-full', TONE_DOT[p.tone])} aria-hidden />
          {p.text}
        </span>
      ))}
    </p>
  );
}

function SetupGuide() {
  return (
    <Card className="gap-0 py-0">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 font-medium select-none [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
          Hướng dẫn cấu hình Meta App
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            Làm một lần cho mỗi Meta App
          </span>
        </summary>
        <div className="flex flex-col gap-5 px-5 pb-5 text-sm">
          <div className="flex flex-col gap-2">
            <p className="font-medium">1. Bật Facebook Login for Business</p>
            <p className="text-muted-foreground">
              Meta App phải là loại <strong>Business</strong>. Thêm sản phẩm{' '}
              <em>Facebook Login for Business</em> và <em>Messenger</em>. Trong Facebook Login → Cài đặt, khai
              báo <strong>Valid OAuth Redirect URI</strong>:
            </p>
            <CopyField value={FACEBOOK_OAUTH_REDIRECT_URI} label="Chép Redirect URI" />
            <p className="text-muted-foreground">
              Tùy chọn: tạo <em>Configuration</em> (loại token: <strong>User access token</strong>, quyền như
              bước 3) rồi đặt ID vào biến <code className="font-mono text-xs">META_LOGIN_CONFIG_ID</code> của
              máy chủ.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">2. Khai báo webhook (Messenger → Cài đặt)</p>
            <CopyField value={MESSENGER_WEBHOOK_URL} label="Chép URL webhook" />
            <p className="text-muted-foreground">
              Verify token: giá trị <code className="font-mono text-xs">META_VERIFY_TOKEN</code> trong cấu
              hình máy chủ. Hệ thống tự đăng ký từng Trang nhận tin khi kết nối.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">3. Quyền cần cấp</p>
            <p className="text-muted-foreground">
              <code className="font-mono text-xs">pages_show_list</code>,{' '}
              <code className="font-mono text-xs">pages_manage_metadata</code>,{' '}
              <code className="font-mono text-xs">pages_messaging</code> và tính năng{' '}
              <em>Business Asset User Profile Access</em> (tên, ảnh khách). Khi App ở chế độ Development chỉ
              người có vai trò trong App đăng nhập được; để dùng với mọi Trang cần App Review + Business
              Verification (Advanced Access).
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">4. Kết nối Trang</p>
            <p className="text-muted-foreground">
              Bấm <strong>Kết nối → Facebook</strong>, đăng nhập bằng tài khoản quản trị Trang, chọn các Trang
              cần kết nối. Token Trang lấy theo cách này không hết hạn, nhưng sẽ mất hiệu lực nếu đổi mật khẩu
              Facebook hoặc mất quyền trên Trang — khi đó kênh chuyển “Token hết hạn”, bấm “Kết nối lại”.
            </p>
          </div>
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Cách thủ công: dán Page Access Token
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                Trong Graph API Explorer, chọn App và lấy User Token với 3 quyền ở bước 3 (tài khoản phải quản
                trị Trang).
              </li>
              <li>
                Đổi sang token dài hạn:{' '}
                <code className="font-mono text-xs break-all">
                  GET
                  /oauth/access_token?grant_type=fb_exchange_token&amp;client_id=APP_ID&amp;client_secret=APP_SECRET&amp;fb_exchange_token=TOKEN
                </code>
              </li>
              <li>
                Gọi <code className="font-mono text-xs">GET /me/accounts</code> bằng token dài hạn: trường{' '}
                <code className="font-mono text-xs">access_token</code> của từng Trang là Page Access Token.
                Sau đó bấm <strong>Kết nối → Dán Page Access Token</strong>.
              </li>
            </ol>
          </details>
        </div>
      </details>
    </Card>
  );
}

type DialogState =
  | { kind: 'connect'; reconnect?: ChannelAccountDto }
  | { kind: 'edit'; channel: ChannelAccountDto }
  | { kind: 'disconnect'; channel: ChannelAccountDto }
  | { kind: 'sync'; channel: ChannelAccountDto }
  | { kind: 'delete'; channel: ChannelAccountDto }
  | null;

function LoadingGrid() {
  return (
    <ul className="grid gap-4 lg:grid-cols-2" aria-hidden>
      {[0, 1].map((i) => (
        <li key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-8 w-36" />
        </li>
      ))}
    </ul>
  );
}

export function ChannelsAdmin() {
  const channels = useChannels({ poll: true });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [fbSession, clearFbSession] = useFacebookReturn();
  const startFacebook = useStartFacebookLogin();
  const close = () => setDialog(null);
  const list = channels.data ?? [];
  const { active, disconnected } = splitChannels(list);

  // Kênh kết nối bằng Facebook Login => kết nối lại bằng Facebook; còn lại dùng hộp thoại dán token.
  const reconnect = (ch: ChannelAccountDto) =>
    ch.connectedBy?.provider === 'facebook_login'
      ? startFacebook.mutate()
      : setDialog({ kind: 'connect', reconnect: ch });

  const actionsFor = (ch: ChannelAccountDto): ChannelActions => ({
    onEdit: () => setDialog({ kind: 'edit', channel: ch }),
    onDisconnect: () => setDialog({ kind: 'disconnect', channel: ch }),
    onReconnect: () => reconnect(ch),
    onSync: () => setDialog({ kind: 'sync', channel: ch }),
    onDelete: () => setDialog({ kind: 'delete', channel: ch }),
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:py-8">
      <header className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Kênh</h1>
          <p className="text-sm text-muted-foreground">
            Các Trang Facebook nhận và gửi tin qua hộp thư. Mỗi kênh có tên và màu nhãn riêng.
          </p>
          {channels.isSuccess && list.length > 0 && <SummaryLine channels={list} />}
        </div>
        <ConnectMenu onPasteToken={() => setDialog({ kind: 'connect' })} />
      </header>

      {channels.isPending ? (
        <LoadingGrid />
      ) : channels.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(channels.error, 'Không tải được danh sách kênh.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void channels.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand/10 text-brand">
            <Plug className="size-6" aria-hidden />
          </span>
          <p className="font-medium">Chưa có kênh nào</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Bấm “Kết nối → Facebook” để đăng nhập và chọn Trang, bắt đầu nhận tin nhắn Messenger trong hộp
            thư.
          </p>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-3" aria-labelledby="active-channels-title">
            <h2 id="active-channels-title" className="text-sm font-medium text-muted-foreground">
              Kênh đang kết nối ({active.length})
            </h2>
            {active.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                Chưa có kênh nào đang kết nối. Bấm “Kết nối” để thêm Trang, hoặc kết nối lại một kênh bên
                dưới.
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {active.map((ch) => (
                  <ChannelCard key={ch.id} channel={ch} actions={actionsFor(ch)} />
                ))}
              </ul>
            )}
          </section>
          {disconnected.length > 0 && <DisconnectedSection channels={disconnected} actionsFor={actionsFor} />}
        </>
      )}

      <SetupGuide />

      <ConnectMessengerDialog
        open={dialog?.kind === 'connect'}
        reconnect={dialog?.kind === 'connect' ? dialog.reconnect : undefined}
        onOpenChange={(open) => !open && close()}
      />
      {dialog?.kind === 'edit' && (
        <EditChannelDialog
          key={dialog.channel.id}
          channel={dialog.channel}
          onOpenChange={(o) => !o && close()}
        />
      )}
      {dialog?.kind === 'disconnect' && (
        <DisconnectChannelDialog channel={dialog.channel} onOpenChange={(o) => !o && close()} />
      )}
      {dialog?.kind === 'sync' && (
        <SyncHistoryDialog channel={dialog.channel} onOpenChange={(o) => !o && close()} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteChannelDialog
          key={dialog.channel.id}
          channel={dialog.channel}
          onOpenChange={(o) => !o && close()}
        />
      )}
      {fbSession && <FacebookPagesDialog key={fbSession} sessionId={fbSession} onClose={clearFbSession} />}
    </main>
  );
}
