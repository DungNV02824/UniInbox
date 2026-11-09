'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Trash2, TriangleAlert } from 'lucide-react';
import {
  connectMessengerPageSchema,
  updateChannelSchema,
  type ChannelAccountDto,
  type UpdateChannelRequest,
} from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import {
  deleteChannel,
  deleteErrorText,
  deleteImpactText,
  formatCount,
  isDeleteConfirmed,
  normalizeConfirmName,
} from '@/lib/channels-admin';
import { channelsApi } from '@/lib/inbox-api';
import { channelsKey } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { ColorPicker } from './color-picker';

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function useInvalidateChannels() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: channelsKey });
    // Nhãn kênh nằm trong từng hội thoại.
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };
}

/** Kết nối Fanpage bằng Page Access Token (cũng dùng để kết nối lại / thay token). */
export function ConnectMessengerDialog({
  open,
  onOpenChange,
  reconnect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kết nối lại một Page đã có: không gửi tên/màu trừ khi admin đổi. */
  reconnect?: ChannelAccountDto;
}) {
  const toast = useToast();
  const invalidate = useInvalidateChannels();
  const [token, setToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [color, setColor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: channelsApi.connectMessenger,
    onSuccess: (channel) => {
      invalidate();
      toast({
        title: reconnect ? 'Đã kết nối lại Fanpage' : 'Đã kết nối Fanpage',
        description: [channel?.displayName, 'Đang đồng bộ lịch sử tin nhắn ở nền.']
          .filter(Boolean)
          .join(' · '),
        variant: 'success',
      });
      close(false);
    },
    onError: (err) => setError(errorText(err, 'Không kết nối được Fanpage.')),
  });

  function close(next: boolean) {
    if (!next) {
      setToken('');
      setDisplayName('');
      setColor(undefined);
      setError(null);
      mutation.reset();
    }
    onOpenChange(next);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = connectMessengerPageSchema.safeParse({
      pageAccessToken: token,
      displayName: displayName.trim() || undefined,
      color,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.path[0] === 'pageAccessToken'
          ? 'Page Access Token không hợp lệ (quá ngắn hoặc quá dài).'
          : (issue?.message ?? 'Dữ liệu không hợp lệ.'),
      );
      return;
    }
    mutation.mutate(parsed.data);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={reconnect ? `Kết nối lại "${reconnect.displayName}"` : 'Dán Page Access Token'}
      description="Dán Page Access Token dài hạn của Fanpage. Hệ thống sẽ kiểm tra token và tự đăng ký nhận tin (webhook) cho Page."
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="page-token">Page Access Token</Label>
          <Textarea
            id="page-token"
            data-autofocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAG..."
            autoComplete="off"
            spellCheck={false}
            className="min-h-24 font-mono text-xs break-all"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="page-name">Tên hiển thị (tùy chọn)</Label>
          <Input
            id="page-name"
            value={displayName}
            maxLength={100}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={reconnect ? reconnect.displayName : 'Mặc định: tên Fanpage trên Facebook'}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Màu nhãn (tùy chọn)</span>
          <ColorPicker value={color} onChange={setColor} allowAuto />
          {reconnect && color === undefined && (
            <p className="text-xs text-muted-foreground">Để trống tên/màu thì giữ nguyên như hiện tại.</p>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={mutation.isPending}>
            Hủy
          </Button>
          <Button type="submit" variant="brand" disabled={mutation.isPending || !token.trim()}>
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {mutation.isPending ? 'Đang kiểm tra...' : 'Kết nối'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Sửa tên hiển thị và màu nhãn của một kênh. */
export function EditChannelDialog({
  channel,
  onOpenChange,
}: {
  channel: ChannelAccountDto;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateChannels();
  const [displayName, setDisplayName] = useState(channel.displayName);
  const [color, setColor] = useState<string | undefined>(channel.color);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: UpdateChannelRequest) => channelsApi.update(channel.id, body),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Đã lưu thay đổi', variant: 'success' });
      onOpenChange(false);
    },
    onError: (err) => setError(errorText(err, 'Không lưu được thay đổi.')),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = displayName.trim();
    const body: UpdateChannelRequest = {
      ...(name !== channel.displayName && { displayName: name }),
      ...(color && color.toLowerCase() !== channel.color.toLowerCase() && { color }),
    };
    if (body.displayName === undefined && body.color === undefined) {
      onOpenChange(false);
      return;
    }
    const parsed = updateChannelSchema.safeParse(body);
    if (!parsed.success) {
      setError(
        name ? (parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ.') : 'Vui lòng nhập tên hiển thị.',
      );
      return;
    }
    mutation.mutate(parsed.data);
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Sửa kênh"
      description="Tên và màu nhãn hiển thị trong hộp thư."
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="channel-name">Tên hiển thị</Label>
          <Input
            id="channel-name"
            data-autofocus
            value={displayName}
            maxLength={100}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Màu nhãn</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Hủy
          </Button>
          <Button type="submit" variant="brand" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Lưu
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Xác nhận ngắt kết nối kênh. */
export function DisconnectChannelDialog({
  channel,
  onOpenChange,
}: {
  channel: ChannelAccountDto;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateChannels();
  const mutation = useMutation({
    mutationFn: () => channelsApi.disconnect(channel.id),
    onSuccess: () => {
      invalidate();
      toast({ title: 'Đã ngắt kết nối', description: channel.displayName, variant: 'success' });
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Ngắt kết nối "${channel.displayName}"?`}
      description="Hộp thư sẽ ngừng nhận và gửi tin qua kênh này. Lịch sử hội thoại vẫn được giữ; có thể kết nối lại bất cứ lúc nào."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Hủy
          </Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Ngắt kết nối
          </Button>
        </>
      }
    >
      <FormError message={mutation.isError ? errorText(mutation.error, 'Không ngắt kết nối được.') : null} />
    </Dialog>
  );
}

/**
 * Xóa hẳn một kênh không còn kết nối: phải gõ lại đúng tên kênh mới bật được nút "Xóa vĩnh viễn".
 * API xóa kênh cùng hội thoại, tin nhắn, tệp đính kèm và khách chỉ có trên kênh này.
 */
export function DeleteChannelDialog({
  channel,
  onOpenChange,
}: {
  channel: ChannelAccountDto;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateChannels();
  const [confirmName, setConfirmName] = useState('');
  const confirmed = isDeleteConfirmed(confirmName, channel.displayName);

  const mutation = useMutation({
    mutationFn: () => deleteChannel(channel.id, { confirmName: normalizeConfirmName(confirmName) }),
    onSuccess: (result) => {
      invalidate();
      toast({
        title: `Đã xóa kênh "${channel.displayName}"`,
        description: result
          ? `Đã xóa ${formatCount(result.conversations)} hội thoại, ${formatCount(result.messages)} tin nhắn.`
          : undefined,
        variant: 'success',
      });
      onOpenChange(false);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed || mutation.isPending) return;
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={`Xóa kênh "${channel.displayName}"?`}
      description="Kênh sẽ bị xóa vĩnh viễn khỏi hộp thư. Thao tác này không thể hoàn tác."
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={mutation.isError ? deleteErrorText(mutation.error) : null} />
        <div className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
          <div className="flex flex-col gap-1.5">
            <p className="font-medium">{deleteImpactText(channel.stats)}.</p>
            <p>
              Toàn bộ hội thoại, tin nhắn, tệp đính kèm của kênh và những khách chỉ nhắn qua kênh này cũng bị
              xóa. Khách còn nhắn qua kênh khác vẫn được giữ.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="delete-confirm">
            Gõ <span className="font-semibold text-foreground select-all">{channel.displayName}</span> để xác
            nhận
          </Label>
          <Input
            id="delete-confirm"
            data-autofocus
            value={confirmName}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setConfirmName(e.target.value);
              if (mutation.isError) mutation.reset();
            }}
            placeholder={channel.displayName}
            aria-describedby="delete-confirm-hint"
          />
          <p id="delete-confirm-hint" className="text-xs text-muted-foreground">
            Phân biệt chữ hoa, chữ thường và dấu. Mẹo: bấm vào tên kênh ở trên để chọn rồi sao chép, dán vào ô
            này.
          </p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Hủy
          </Button>
          <Button type="submit" variant="destructive" disabled={!confirmed || mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            {mutation.isPending ? 'Đang xóa...' : 'Xóa vĩnh viễn'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
