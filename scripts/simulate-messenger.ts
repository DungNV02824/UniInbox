// Giả lập webhook Messenger cho dev: dựng payload, ký X-Hub-Signature-256 bằng META_APP_SECRET (.env gốc) rồi POST.
// Chạy (không thêm dependency, dùng tsx của worker):
//   pnpm --filter @dezon/worker exec tsx ../../scripts/simulate-messenger.ts --page <id> --psid <id> --text "Xin chào"
// Lưu ý: khi script thoát với mã lỗi, pnpm (Windows) in nhầm "Command "tsx" not found" — xem dòng lỗi phía trên.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const USAGE = `Giả lập webhook Messenger -> API (mặc định http://localhost:4000/webhooks/messenger)

Cách dùng:
  pnpm --filter @dezon/worker exec tsx ../../scripts/simulate-messenger.ts --page <PAGE_ID> --psid <PSID> [tuỳ chọn]

Loại sự kiện (chọn một; mặc định là tin text của khách):
  --text "..."        Tin nhắn văn bản của khách
  --image <url>       Ảnh từ URL công khai (có thể kèm --text)
  --echo              Biến tin thành echo từ Hộp thư Page/Business Suite (app_id 263902037430900)
  --delivery <mid>    Báo đã giao tin <mid> (watermark = bây giờ)
  --read              Báo khách đã xem (watermark = bây giờ)

Khác:
  --mid <mid>         Đặt message id (mặc định ngẫu nhiên)
  --repeat            Gửi cùng payload 2 lần (kiểm tra chống trùng)
  --url <url>         Đổi địa chỉ webhook

Page phải là Fanpage đã kết nối trong hệ thống (channel_accounts.external_id), nếu không tin bị bỏ qua.`;

/** Tìm thư mục gốc repo (có pnpm-workspace.yaml) từ cwd đi lên. */
function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Không tìm thấy thư mục gốc repo (pnpm-workspace.yaml)');
    dir = parent;
  }
  return dir;
}

function loadAppSecret(): string {
  const fromEnv = process.env.META_APP_SECRET;
  if (fromEnv) return fromEnv;
  const envPath = join(findRepoRoot(process.cwd()), '.env');
  const secret = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')).META_APP_SECRET : undefined;
  if (!secret) throw new Error(`Thiếu META_APP_SECRET (trong ${envPath} hoặc biến môi trường)`);
  return secret;
}

const randomMid = () => `m_sim_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

function buildEvent(opts: Record<string, string | boolean | undefined>, page: string, psid: string) {
  const now = Date.now();
  const customer = { sender: { id: psid }, recipient: { id: page }, timestamp: now };
  if (typeof opts.delivery === 'string') {
    return { ...customer, delivery: { mids: [opts.delivery], watermark: now } };
  }
  if (opts.read) return { ...customer, read: { watermark: now } };

  const message: Record<string, unknown> = { mid: typeof opts.mid === 'string' ? opts.mid : randomMid() };
  if (typeof opts.text === 'string') message.text = opts.text;
  if (typeof opts.image === 'string') message.attachments = [{ type: 'image', payload: { url: opts.image } }];
  if (!message.text && !message.attachments) message.text = 'Tin nhắn thử từ simulate-messenger';
  if (opts.echo) {
    // Echo: sender = page, recipient = khách.
    return {
      sender: { id: page },
      recipient: { id: psid },
      timestamp: now,
      message: { is_echo: true, app_id: 263902037430900, ...message },
    };
  }
  return { ...customer, message };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      page: { type: 'string' },
      psid: { type: 'string' },
      text: { type: 'string' },
      image: { type: 'string' },
      echo: { type: 'boolean' },
      delivery: { type: 'string' },
      read: { type: 'boolean' },
      mid: { type: 'string' },
      repeat: { type: 'boolean' },
      url: { type: 'string', default: 'http://localhost:4000/webhooks/messenger' },
    },
  });
  if (!values.page || !values.psid) {
    console.log(USAGE);
    process.exitCode = values.page || values.psid ? 1 : 0;
    return;
  }

  const secret = loadAppSecret();
  const payload = {
    object: 'page',
    entry: [{ id: values.page, time: Date.now(), messaging: [buildEvent(values, values.page, values.psid)] }],
  };
  // Escape ký tự ngoài ASCII như Meta (chữ ký tính trên đúng bytes gửi đi).
  const body = JSON.stringify(payload).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  const times = values.repeat ? 2 : 1;
  for (let i = 1; i <= times; i++) {
    const res = await fetch(values.url as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body,
    });
    console.log(`[${i}/${times}] ${res.status} ${await res.text()}`);
  }
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
