'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RefreshCw, Tags } from 'lucide-react';
import { CONTACT_TAGS_MAX, type ContactTagDto, type TagColor } from '@dezon/shared';
import { TagChip } from '@/components/tag-chip';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { applyTagOrder, moveItem, sortTags, TAG_NAME_MAX, validateTagName } from '@/lib/contact-tags';
import { contactTagKeys, contactTagsApi } from '@/lib/contact-tags-api';
import { errorText } from '@/lib/inbox-queries';
import { DeleteTagDialog, TagRow } from './tag-row';
import { TagColorPicker } from './tag-color-picker';

/** Trang quản trị luôn lấy số khách mới nhất. */
function useAdminTags() {
  return useQuery({
    queryKey: contactTagKeys.all,
    queryFn: () => contactTagsApi.list(),
    select: sortTags,
    staleTime: 0,
  });
}

function AddTagForm({ catalog }: { catalog: ContactTagDto[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('blue');
  const [error, setError] = useState<string | null>(null);
  const full = catalog.length >= CONTACT_TAGS_MAX;

  const create = useMutation({
    mutationFn: () => contactTagsApi.create({ name: name.trim(), color }),
    onSuccess: (tag) => {
      qc.setQueryData<ContactTagDto[]>(contactTagKeys.all, (old) => (old ? [...old, tag] : [tag]));
      void qc.invalidateQueries({ queryKey: contactTagKeys.all });
      toast({ title: `Đã thêm nhãn "${tag.name}"`, variant: 'success' });
      setName('');
      setError(null);
    },
    onError: (err) => setError(errorText(err, 'Không thêm được nhãn.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (create.isPending || full) return;
    const invalid = validateTagName(name, catalog);
    if (invalid) return setError(invalid);
    create.mutate();
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs sm:p-5"
      aria-labelledby="add-tag-title"
    >
      <h2 id="add-tag-title" className="font-semibold">
        Thêm nhãn
      </h2>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-tag-name">Tên nhãn</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="new-tag-name"
            value={name}
            maxLength={TAG_NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="Vd. Khách VIP, Đã báo giá..."
            aria-invalid={!!error}
            aria-describedby={error ? 'new-tag-error' : undefined}
            disabled={full}
            className="min-w-48 flex-1"
          />
          {name.trim() && <TagChip name={name.trim()} color={color} className="max-w-60" />}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Màu</span>
        <TagColorPicker value={color} onChange={setColor} label="Màu nhãn mới" disabled={full} />
      </div>
      {error && (
        <p id="new-tag-error" className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {full && (
        <p className="text-sm text-muted-foreground">
          Đã đủ {CONTACT_TAGS_MAX} nhãn. Xóa bớt nhãn không dùng để thêm nhãn mới.
        </p>
      )}
      <Button type="submit" variant="brand" className="w-fit" disabled={create.isPending || full}>
        {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
        Thêm nhãn
      </Button>
    </form>
  );
}

export function TagsAdmin() {
  const tags = useAdminTags();
  const qc = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState<ContactTagDto | null>(null);
  const list = tags.data ?? [];

  const reorder = useMutation({
    mutationFn: (ids: string[]) => contactTagsApi.reorder(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: contactTagKeys.all });
      const prev = qc.getQueryData<ContactTagDto[]>(contactTagKeys.all);
      qc.setQueryData<ContactTagDto[]>(contactTagKeys.all, (old) => (old ? applyTagOrder(old, ids) : old));
      return { prev };
    },
    onError: (err, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(contactTagKeys.all, ctx.prev);
      toast({ title: 'Không đổi được thứ tự nhãn', description: errorText(err), variant: 'destructive' });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: contactTagKeys.all }),
  });

  function move(index: number, delta: -1 | 1) {
    const ids = moveItem(
      list.map((t) => t.id),
      index,
      delta,
    );
    reorder.mutate(ids);
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6 lg:py-8">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Nhãn khách</h1>
        <p className="text-sm text-muted-foreground">
          Bộ nhãn cố định (tên + màu) để nhân viên chọn khi gắn nhãn cho khách — không phải gõ tay nên không
          sai chính tả. Đổi tên nhãn sẽ đổi luôn trên mọi khách đang có nhãn đó.
        </p>
        {tags.isSuccess && list.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {list.length}/{CONTACT_TAGS_MAX} nhãn
          </p>
        )}
      </header>

      {tags.isPending ? (
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : tags.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(tags.error, 'Không tải được danh sách nhãn.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void tags.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <AddTagForm catalog={list} />
          {list.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-10 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-brand/10 text-brand">
                <Tags className="size-6" aria-hidden />
              </span>
              <p className="font-medium">Chưa có nhãn nào</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Thêm các nhãn hay dùng (vd. Khách VIP, Đã báo giá, Cần gọi lại) và chọn màu cho dễ nhận ra.
                Nhân viên sẽ chọn nhãn từ danh sách này trong phần Thông tin khách.
              </p>
            </div>
          ) : (
            <section
              className="flex flex-col rounded-xl border bg-card shadow-xs"
              aria-labelledby="tag-list-title"
            >
              <h2 id="tag-list-title" className="border-b px-4 py-3 font-semibold sm:px-5">
                Danh sách nhãn
              </h2>
              <ul className="flex flex-col divide-y">
                {list.map((tag, i) => (
                  <TagRow
                    key={tag.id}
                    tag={tag}
                    catalog={list}
                    isFirst={i === 0}
                    isLast={i === list.length - 1}
                    reordering={reorder.isPending}
                    onMove={(delta) => move(i, delta)}
                    onDelete={() => setDeleting(tag)}
                  />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {deleting && <DeleteTagDialog key={deleting.id} tag={deleting} onClose={() => setDeleting(null)} />}
    </main>
  );
}
