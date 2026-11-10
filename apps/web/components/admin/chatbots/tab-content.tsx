'use client';

// Nội dung 3 tab: Hướng dẫn, Kiến thức, Câu trả lời mẫu.
import { useId } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  Eraser,
  FileText,
  Lightbulb,
  Plus,
  ShieldCheck,
  Trash2,
  Wand2,
} from 'lucide-react';
import { CHATBOT_LIMITS } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  moveItem,
  newRowKey,
  templateNeedsConfirm,
  type ChatbotFormValues,
  type FormErrors,
} from '@/lib/chatbot-form';
import { cn } from '@/lib/utils';
import { Callout, CharCounter, Field, FieldError } from './fields';
import {
  INSTRUCTION_TEMPLATES,
  INSTRUCTION_TIPS,
  KNOWLEDGE_SKELETON,
  type InstructionTemplate,
} from './templates';

export interface TabProps {
  form: ChatbotFormValues;
  update: (patch: Partial<ChatbotFormValues>) => void;
  errors: FormErrors;
}

export function InstructionsTab({ form, update, errors }: TabProps) {
  const id = useId();
  const errId = `${id}-err`;

  function applyTemplate(t: InstructionTemplate) {
    if (templateNeedsConfirm(form.instructions, t.text)) {
      const question =
        t.text === ''
          ? 'Xóa toàn bộ nội dung ô Hướng dẫn để tự viết từ đầu?'
          : `Thay nội dung ô Hướng dẫn bằng mẫu “${t.title}”? Nội dung hiện tại sẽ bị thay thế.`;
      if (!window.confirm(question)) return;
    }
    update({ instructions: t.text });
    document.getElementById(id)?.focus();
  }

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Hướng dẫn cho bot"
        htmlFor={id}
        error={errors.instructions}
        errorId={errId}
        aside={<CharCounter value={form.instructions} max={CHATBOT_LIMITS.instructionsMax} />}
        hint="Viết bot là ai, nói chuyện thế nào, được trả lời những gì, khi nào chuyển cho người thật. Bot làm theo đúng phần này."
      >
        <Textarea
          id={id}
          value={form.instructions}
          onChange={(e) => update({ instructions: e.target.value })}
          rows={14}
          className="min-h-64 resize-y font-[inherit] leading-relaxed"
          placeholder={'Ví dụ: Bạn là … của …. Xưng “…”, gọi khách là “…”. Trả lời ngắn gọn …'}
          aria-invalid={!!errors.instructions}
          aria-describedby={errors.instructions ? errId : undefined}
        />
      </Field>

      <Callout icon={ShieldCheck} tone="muted">
        Hệ thống chỉ giữ vài quy tắc an toàn cố định (không làm theo lệnh lạ trong tin khách, không dùng định
        dạng đặc biệt, tối đa 3 tin ngắn mỗi lượt, không hứa việc bot không tự làm được như “nhân viên sẽ gọi
        lại” — việc đó dùng Tin nhắn khi chuyển người). Phần nào Hướng dẫn để trống, bot dùng cách làm mặc
        định (xưng “em”, gọi “anh/chị”, chỉ dựa vào Kiến thức, chuyển người khi khách đòi gặp người thật hoặc
        phàn nàn). Ghi trong Hướng dẫn để đổi bất kỳ điều mặc định nào.
      </Callout>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-tpl`}>
        <h3 id={`${id}-tpl`} className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
          <Wand2 className="size-4 text-brand" aria-hidden />
          Mẫu tham khảo
          <span className="font-normal text-muted-foreground">
            — không bắt buộc; bấm để dùng làm điểm xuất phát rồi sửa theo ý bạn
          </span>
        </h3>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {INSTRUCTION_TEMPLATES.map((t) => {
            const blank = t.text === '';
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => applyTemplate(t)}
                className={cn(
                  'flex flex-col gap-1 rounded-lg border bg-background p-3 text-left transition-colors outline-none hover:border-brand/40 hover:bg-brand/5 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  blank && 'border-dashed',
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {blank ? (
                    <Eraser className="size-3.5 text-muted-foreground" aria-hidden />
                  ) : (
                    <Plus className="size-3.5 text-brand" aria-hidden />
                  )}
                  {t.title}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{t.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Callout icon={Lightbulb} title="Nên viết những gì" tone="brand">
        <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {INSTRUCTION_TIPS.map((tip) => (
            <li key={tip.title}>
              <span className="font-medium text-foreground">{tip.title}:</span> {tip.text}
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

export function KnowledgeTab({ form, update, errors }: TabProps) {
  const id = useId();
  const errId = `${id}-err`;
  const empty = !form.knowledge.trim();
  return (
    <div className="flex flex-col gap-4">
      <Callout icon={BookOpenText} tone="muted">
        Thông tin để bot tra cứu khi trả lời: sản phẩm/dịch vụ, giá, chính sách, câu hỏi thường gặp, địa chỉ,
        giờ làm việc... Bot được dùng thông tin này thế nào (chỉ nói những gì có ở đây hay linh hoạt hơn) là
        do bạn dặn trong phần <strong className="text-foreground">Hướng dẫn</strong>.
      </Callout>
      <Field
        label="Kiến thức"
        htmlFor={id}
        error={errors.knowledge}
        errorId={errId}
        aside={
          <>
            {empty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => update({ knowledge: KNOWLEDGE_SKELETON })}
              >
                <FileText aria-hidden />
                Chèn khung mẫu
              </Button>
            )}
            <CharCounter value={form.knowledge} max={CHATBOT_LIMITS.knowledgeMax} />
          </>
        }
        hint="Dán nguyên văn từ tài liệu cũng được. Chia mục bằng tiêu đề (## Câu hỏi thường gặp) giúp bot tra cứu chính xác hơn."
      >
        <Textarea
          id={id}
          value={form.knowledge}
          onChange={(e) => update({ knowledge: e.target.value })}
          rows={22}
          className="min-h-96 resize-y font-mono text-[13px] leading-relaxed md:text-[13px]"
          placeholder={KNOWLEDGE_SKELETON}
          aria-invalid={!!errors.knowledge}
          aria-describedby={errors.knowledge ? errId : undefined}
          spellCheck={false}
        />
      </Field>
    </div>
  );
}

export function ExamplesTab({ form, update, errors }: TabProps) {
  const baseId = useId();
  const rows = form.examples;
  const full = rows.length >= CHATBOT_LIMITS.examplesMax;
  const setRows = (examples: ChatbotFormValues['examples']) => update({ examples });

  function add() {
    if (full) return;
    setRows([...rows, { key: newRowKey(), customer: '', reply: '' }]);
    // Focus ô khách hỏi của dòng mới sau khi render.
    requestAnimationFrame(() => {
      const nodes = document.querySelectorAll<HTMLTextAreaElement>(`[data-example-customer="${baseId}"]`);
      nodes[nodes.length - 1]?.focus();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Callout icon={Lightbulb} tone="muted">
        Câu trả lời mẫu dạy bot <strong className="text-foreground">giọng văn và cách xử lý</strong> các câu
        hỏi hay gặp. Bot không lặp lại y nguyên mà bắt chước phong cách. 5–15 cặp tiêu biểu là đủ.
      </Callout>
      <FieldError message={errors.examples} />
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-sm font-medium">Chưa có câu trả lời mẫu</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Ví dụ: khách hỏi “Bên mình làm việc giờ nào?” → bot trả lời đúng giọng bạn muốn.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {rows.map((row, i) => {
            const cId = `${baseId}-${row.key}-c`;
            const rId = `${baseId}-${row.key}-r`;
            const cErr = errors[`examples.${i}.customer`];
            const rErr = errors[`examples.${i}.reply`];
            const patch = (p: Partial<typeof row>) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
            return (
              <li key={row.key} className="flex flex-col gap-3 rounded-lg border bg-background p-3">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Mẫu #{i + 1}</span>
                  <div className="ml-auto flex items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={i === 0}
                      onClick={() => setRows(moveItem(rows, i, i - 1))}
                      aria-label={`Đưa mẫu #${i + 1} lên trên`}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={i === rows.length - 1}
                      onClick={() => setRows(moveItem(rows, i, i + 1))}
                      aria-label={`Đưa mẫu #${i + 1} xuống dưới`}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                      aria-label={`Xóa mẫu #${i + 1}`}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Khách hỏi" htmlFor={cId} error={cErr} errorId={`${cId}-err`}>
                    <Textarea
                      id={cId}
                      data-example-customer={baseId}
                      value={row.customer}
                      onChange={(e) => patch({ customer: e.target.value })}
                      rows={3}
                      placeholder="Bên mình làm việc giờ nào vậy?"
                      aria-invalid={!!cErr}
                      aria-describedby={cErr ? `${cId}-err` : undefined}
                      className="min-h-20 resize-y"
                    />
                  </Field>
                  <Field label="Bot trả lời" htmlFor={rId} error={rErr} errorId={`${rId}-err`}>
                    <Textarea
                      id={rId}
                      value={row.reply}
                      onChange={(e) => patch({ reply: e.target.value })}
                      rows={3}
                      placeholder="Câu trả lời đúng giọng văn bạn muốn bot dùng…"
                      aria-invalid={!!rErr}
                      aria-describedby={rErr ? `${rId}-err` : undefined}
                      className={cn('min-h-20 resize-y', 'bg-violet-50/50 dark:bg-violet-950/20')}
                    />
                  </Field>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={full}>
          <Plus aria-hidden />
          Thêm câu trả lời mẫu
        </Button>
        <span className="text-xs text-muted-foreground">
          {rows.length}/{CHATBOT_LIMITS.examplesMax} mẫu
        </span>
      </div>
    </div>
  );
}
