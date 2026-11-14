'use client';

// Tab "Thu thập thông tin": AI lấy thông tin quan trọng từ chat và điền vào ô Ghi chú của khách; mục "Nhật ký
// công trình" ghi lại từng công trình bot đã tiếp nhận (ảnh, địa chỉ, nhà thầu…).
import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ClipboardList, HardHat, Lightbulb, Plus, Tag, Trash2, TriangleAlert } from 'lucide-react';
import { CAPTURE_LIMITS } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  addField,
  CAPTURE_FIELD_SPEC,
  CAPTURE_FIELDS_PATH,
  canAddField,
  fieldErrorAt,
  fieldLabel,
  isBuiltinFieldKey,
  patchField,
  PROJECT_LOG_FIELD_SPEC,
  PROJECT_LOG_FIELDS_PATH,
  removeField,
  resolvePhoneTag,
  type CaptureFieldRow,
  type CaptureFormValues,
  type FieldListSpec,
  type ProjectLogFormValues,
} from '@/lib/chatbot-capture';
import { useContactTags } from '@/lib/contact-tags-api';
import { cn } from '@/lib/utils';
import { Switch } from '../switch';
import { Callout, CharCounter, Field, FieldError } from './fields';
import type { TabProps } from './tab-content';

/** Gợi ý thêm cho từng trường có sẵn (hiện dưới ô hướng dẫn). */
const BUILTIN_NOTES: Record<string, string> = {
  phone: 'Hệ thống còn tự nhận số điện thoại khách gõ trong chat (VD: 0912 345 678), không chỉ dựa vào AI.',
  need: 'Nên ngắn gọn để nhân viên đọc nhanh, VD: “Thiết kế nhà phố 3 tầng, 5×20 m, ở Thủ Đức”.',
};

/** Gợi ý thêm cho trường có sẵn của Nhật ký công trình. */
const PROJECT_LOG_NOTES: Record<string, string> = {
  dia_chi: 'Thường in trên ảnh Timemark; nên ghi đủ số nhà, đường, phường/xã, quận/huyện, tỉnh/thành.',
  nha_thau: 'Thường lấy từ ảnh chụp biển công trình.',
};

export function CaptureTab({ form, update, errors }: TabProps) {
  const id = useId();
  const capture = form.capture;
  const set = (next: CaptureFormValues) => update({ capture: next });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <FeatureSwitch
          id={`${id}-enabled`}
          icon={ClipboardList}
          title="Bot tự điền thông tin khách vào Ghi chú"
          checked={capture.enabled}
          onCheckedChange={(enabled) => set({ ...capture, enabled })}
        >
          AI đọc tin của khách và điền các trường bên dưới vào ô <strong>Ghi chú</strong> ở khung “Thông tin
          khách” bên phải hộp thư. Trường nhân viên đã tự sửa thì AI không ghi đè.
        </FeatureSwitch>

        <div
          className={cn('flex flex-col gap-6 transition-opacity', !capture.enabled && 'opacity-60')}
          data-muted={!capture.enabled || undefined}
        >
          {!capture.enabled && (
            <p className="-mb-3 text-xs text-muted-foreground">
              Đang tắt — bạn vẫn sửa được các trường, bot chỉ điền khi bật công tắc ở trên.
            </p>
          )}

          <FieldListEditor
            title="Các trường cần lấy"
            description="Mỗi trường là một ô trong phần Ghi chú. Viết hướng dẫn ngắn để AI biết cần lấy gì và ghi thế nào."
            rows={capture.fields}
            spec={CAPTURE_FIELD_SPEC}
            errorPath={CAPTURE_FIELDS_PATH}
            errors={errors}
            notes={BUILTIN_NOTES}
            labelPlaceholder="Tên trường, VD: Khu vực"
            hintPlaceholder="VD: Khách ở tỉnh/thành, quận/huyện nào. Không rõ thì để trống, không đoán."
            addPlaceholder="Tên trường mới, VD: Khu vực, Ngân sách, Thời gian thi công"
            listError={errors[CAPTURE_FIELDS_PATH] ?? errors.capture}
            onChange={(fields) => set({ ...capture, fields })}
          />

          <PhoneTagField
            id={`${id}-tag`}
            value={capture.phoneTag}
            onChange={(phoneTag) => set({ ...capture, phoneTag })}
            error={errors['capture.phoneTag']}
          />

          <Callout icon={Lightbulb} title="Mẹo" tone="muted">
            <p>
              Trường AI điền có dấu <strong className="text-foreground">AI</strong> nhỏ bên cạnh. Nhân viên
              sửa tay một trường thì từ đó AI không ghi đè trường đó nữa.
            </p>
          </Callout>
        </div>
      </div>

      <ProjectLogSection
        id={`${id}-plog`}
        value={capture.projectLog}
        onChange={(projectLog) => set({ ...capture, projectLog })}
        errors={errors}
      />
    </div>
  );
}

/** Ô bật/tắt một tính năng (biểu tượng + tiêu đề + giải thích + công tắc). */
function FeatureSwitch({
  id,
  icon: Icon,
  title,
  checked,
  onCheckedChange,
  children,
}: {
  id: string;
  icon: typeof ClipboardList;
  title: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {title}
        </label>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** Mục "Nhật ký công trình": công tắc + các trường của một dòng nhật ký. */
function ProjectLogSection({
  id,
  value,
  onChange,
  errors,
}: {
  id: string;
  value: ProjectLogFormValues;
  onChange: (next: ProjectLogFormValues) => void;
  errors: Record<string, string>;
}) {
  return (
    <section className="flex flex-col gap-6 border-t pt-6" aria-labelledby={`${id}-title`}>
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-base font-semibold">
          Nhật ký công trình
        </h3>
        <p className="text-xs text-muted-foreground">
          Dành cho cộng tác viên gửi bộ ảnh công trình (ảnh Timemark có địa chỉ, ngày chụp; ảnh biển công
          trình có tên và số điện thoại nhà thầu). Mỗi lần bot xác nhận tiếp nhận một công trình, hệ thống ghi
          một dòng nhật ký với các trường bên dưới.
        </p>
      </div>

      <FeatureSwitch
        id={`${id}-enabled`}
        icon={HardHat}
        title="Bot ghi nhật ký khi tiếp nhận công trình"
        checked={value.enabled}
        onCheckedChange={(enabled) => onChange({ ...value, enabled })}
      >
        Các dòng nhật ký hiện ở mục <strong>Nhật ký công trình</strong> trong khung “Thông tin khách” bên phải
        hộp thư. Bấm vào một dòng để khung chat cuộn tới đúng các tin (kèm ảnh) của công trình đó. Không phụ
        thuộc công tắc Ghi chú ở trên.
      </FeatureSwitch>

      <div
        className={cn('flex flex-col gap-6 transition-opacity', !value.enabled && 'opacity-60')}
        data-muted={!value.enabled || undefined}
      >
        {!value.enabled && (
          <p className="-mb-3 text-xs text-muted-foreground">
            Đang tắt — bạn vẫn sửa được các trường, bot chỉ ghi nhật ký khi bật công tắc ở trên.
          </p>
        )}
        <FieldListEditor
          title="Thông tin ghi cho mỗi công trình"
          description="Viết hướng dẫn ngắn để AI biết đọc thông tin ở đâu (ảnh, biển công trình, tin nhắn) và ghi thế nào."
          rows={value.fields}
          spec={PROJECT_LOG_FIELD_SPEC}
          errorPath={PROJECT_LOG_FIELDS_PATH}
          errors={errors}
          notes={PROJECT_LOG_NOTES}
          labelPlaceholder="Tên trường, VD: Hạng mục"
          hintPlaceholder="VD: Hạng mục đang thi công (móng, phần thô, hoàn thiện…). Không rõ thì để trống, không đoán."
          addPlaceholder="Tên trường mới, VD: Hạng mục, Chủ đầu tư, Quy mô"
          listError={errors[PROJECT_LOG_FIELDS_PATH] ?? errors['capture.projectLog']}
          onChange={(fields) => onChange({ ...value, fields })}
        />
      </div>
    </section>
  );
}

/** Danh sách trường: trường có sẵn (tên cố định, chỉ tắt) + trường riêng (thêm / đổi tên / xóa). */
function FieldListEditor({
  title,
  description,
  rows,
  spec,
  errorPath,
  errors,
  notes,
  labelPlaceholder,
  hintPlaceholder,
  addPlaceholder,
  listError,
  onChange,
}: {
  title: string;
  description: string;
  rows: CaptureFieldRow[];
  spec: FieldListSpec;
  /** Đường dẫn lỗi của danh sách (vd. 'capture.fields'); lỗi ô ở `<errorPath>.<i>.label|hint`. */
  errorPath: string;
  errors: Record<string, string>;
  /** Gợi ý thêm dưới ô hướng dẫn của trường có sẵn. */
  notes: Record<string, string>;
  labelPlaceholder: string;
  hintPlaceholder: string;
  addPlaceholder: string;
  listError?: string;
  onChange: (rows: CaptureFieldRow[]) => void;
}) {
  const id = useId();
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {rows.length}/{spec.maxFields} trường
        </span>
      </div>

      <ul className="flex flex-col gap-3">
        {rows.map((field, index) => (
          <li key={field.key}>
            <FieldCard
              field={field}
              builtin={isBuiltinFieldKey(spec, field.key)}
              label={fieldLabel(spec, field)}
              note={notes[field.key]}
              labelPlaceholder={labelPlaceholder}
              hintPlaceholder={hintPlaceholder}
              labelError={fieldErrorAt(errors, errorPath, index, 'label')}
              hintError={fieldErrorAt(errors, errorPath, index, 'hint')}
              onChange={(patch) => onChange(patchField(rows, field.key, patch, spec))}
              onRemove={() => onChange(removeField(rows, field.key, spec))}
            />
          </li>
        ))}
      </ul>
      <FieldError message={listError} />
      <AddFieldRow
        rows={rows}
        spec={spec}
        onAdd={onChange}
        inputId={`${id}-add`}
        placeholder={addPlaceholder}
      />
    </section>
  );
}

function FieldCard({
  field,
  builtin,
  label,
  note,
  labelPlaceholder,
  hintPlaceholder,
  labelError,
  hintError,
  onChange,
  onRemove,
}: {
  field: CaptureFieldRow;
  builtin: boolean;
  /** Tên hiển thị (trường có sẵn ⇒ tên cố định). */
  label: string;
  note?: string;
  labelPlaceholder: string;
  hintPlaceholder: string;
  labelError?: string;
  hintError?: string;
  onChange: (patch: Partial<Omit<CaptureFieldRow, 'key'>>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const shownLabel = label.trim() || 'Trường mới';

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-2">
        {builtin ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              Có sẵn
            </span>
          </span>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
              id={`${id}-label`}
              value={field.label}
              onChange={(e) => onChange({ label: e.target.value })}
              maxLength={CAPTURE_LIMITS.labelMax}
              placeholder={labelPlaceholder}
              aria-label="Tên trường"
              aria-invalid={!!labelError}
              aria-describedby={labelError ? `${id}-label-err` : undefined}
              className="h-8 font-medium"
            />
            <FieldError id={`${id}-label-err`} message={labelError} />
          </div>
        )}
        <label
          htmlFor={`${id}-on`}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        >
          Bật
          <Switch
            id={`${id}-on`}
            size="sm"
            checked={field.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
            aria-label={`Bật trường ${shownLabel}`}
          />
        </label>
        {!builtin && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label={`Xóa trường ${shownLabel}`}
            title="Xóa trường"
          >
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      <div className={cn('flex flex-col gap-3', !field.enabled && 'opacity-60')}>
        <Field
          label="Hướng dẫn cho AI"
          htmlFor={`${id}-hint`}
          error={hintError}
          errorId={`${id}-hint-err`}
          aside={<CharCounter value={field.hint} max={CAPTURE_LIMITS.hintMax} />}
          hint={note}
        >
          <Textarea
            id={`${id}-hint`}
            value={field.hint}
            onChange={(e) => onChange({ hint: e.target.value })}
            rows={2}
            placeholder={builtin ? undefined : hintPlaceholder}
            aria-invalid={!!hintError}
            aria-describedby={hintError ? `${id}-hint-err` : undefined}
            className="min-h-14 resize-y"
          />
        </Field>
      </div>
    </div>
  );
}

function AddFieldRow({
  rows,
  spec,
  onAdd,
  inputId,
  placeholder,
}: {
  rows: CaptureFieldRow[];
  spec: FieldListSpec;
  onAdd: (next: CaptureFieldRow[]) => void;
  inputId: string;
  placeholder: string;
}) {
  const [label, setLabel] = useState('');
  const full = !canAddField(rows, spec);

  function add() {
    const next = addField(rows, label, spec);
    if (next === rows) return;
    onAdd(next);
    setLabel('');
    // Giữ con trỏ ở ô thêm để thêm nhanh nhiều trường liền.
    document.getElementById(inputId)?.focus();
  }

  if (full) {
    return (
      <p className="text-xs text-muted-foreground">
        Đã đủ {spec.maxFields} trường. Xóa bớt trường riêng để thêm trường khác.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          maxLength={CAPTURE_LIMITS.labelMax}
          placeholder={placeholder}
          aria-label="Tên trường mới"
          className="sm:flex-1"
        />
        <Button variant="outline" onClick={add} disabled={!label.trim()} className="shrink-0">
          <Plus aria-hidden />
          Thêm trường
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Gõ tên trường rồi nhấn Enter hoặc bấm “Thêm trường”, sau đó viết hướng dẫn cho AI.
      </p>
    </div>
  );
}

function PhoneTagField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
}) {
  const tags = useContactTags();
  const choice = resolvePhoneTag(value, tags.data);
  // Nhãn đang chọn chưa nằm trong danh sách (chưa tải xong / không có) ⇒ vẫn có mục để ô chọn hiện đúng.
  const extra = !!choice.value && !tags.data?.some((t) => t.name === choice.value);
  return (
    <Field
      label={
        <span className="flex items-center gap-1.5">
          <Tag className="size-4 text-muted-foreground" aria-hidden />
          Tự gắn nhãn khi lấy được SĐT
        </span>
      }
      htmlFor={id}
      error={error}
      errorId={`${id}-err`}
      hint="Khi bot lấy được số điện thoại của khách, khách được gắn nhãn này (nếu chưa có)."
    >
      <NativeSelect
        id={id}
        value={choice.value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full sm:max-w-xs"
        aria-invalid={!!error || choice.missing}
      >
        <option value="">Không gắn nhãn</option>
        {extra && (
          <option value={choice.value}>
            {choice.missing ? `${choice.value} (chưa có trong Nhãn khách)` : choice.value}
          </option>
        )}
        {(tags.data ?? []).map((t) => (
          <option key={t.id} value={t.name}>
            {t.name}
          </option>
        ))}
      </NativeSelect>
      {choice.missing && (
        <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Nhãn “{choice.value}” chưa có trong danh sách Nhãn khách. Tạo nhãn ở trang{' '}
            <Link href="/admin/tags" className="font-medium underline underline-offset-2">
              Nhãn khách
            </Link>{' '}
            hoặc chọn nhãn khác.
          </span>
        </p>
      )}
      {tags.isError && (
        <p className="text-xs text-muted-foreground">Không tải được danh sách nhãn — thử tải lại trang.</p>
      )}
    </Field>
  );
}
