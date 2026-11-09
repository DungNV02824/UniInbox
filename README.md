# Dezon Omni Inbox

Dezon Omni Inbox là hộp thư hợp nhất cho đội sale của Dezon (dezon.vn): gom tin nhắn từ Fanpage Facebook (Messenger), Zalo OA và Zalo cá nhân của nhân viên về một giao diện duy nhất để xem và trả lời. Các giai đoạn sau bổ sung AI tự trả lời (Claude) có kho kiến thức, đọc ảnh, nhớ khách hàng và biết chuyển cho người thật đúng lúc. Toàn bộ hệ thống viết bằng TypeScript trong một monorepo pnpm + Turborepo. Đặc tả đầy đủ: [`dezon-omnichannel-ai-spec.md`](./dezon-omnichannel-ai-spec.md).

> **Trạng thái:** xong **Giai đoạn 1A — Hộp thư hợp nhất + Fanpage Facebook**, đã nghiệm thu với mock Graph API, chưa thử với Facebook App thật. Xem [`docs/PROGRESS.md`](./docs/PROGRESS.md).

## Yêu cầu

- **Node.js 22** (LTS, xem `.nvmrc`; tối thiểu 22.12)
- **pnpm 9** (bật bằng `corepack enable`; phiên bản chính xác nằm ở trường `packageManager` trong `package.json`)
- **Docker** + Docker Compose (Postgres, Redis, S3, Mailpit cho môi trường dev; Testcontainers khi chạy test)

## Chạy nhanh

```bash
# 1. Tạo file môi trường
cp .env.example .env

# 2. Điền các secret bắt buộc trong .env
#    ENCRYPTION_KEY: 32 byte, mã hóa base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#    JWT_SECRET và JWT_REFRESH_SECRET: chuỗi ngẫu nhiên >= 32 ký tự (mỗi biến một giá trị khác nhau)
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
#    SEED_ADMIN_PASSWORD (và tùy chọn SEED_AGENT_EMAIL / SEED_AGENT_PASSWORD)

# 3. Bật hạ tầng dev (Postgres + pgvector, Redis, S3, Mailpit)
docker compose up -d

# 4. Cài thư viện
pnpm install

# 5. Tạo bảng và dữ liệu mẫu (tài khoản admin seed)
pnpm db:migrate
pnpm db:seed

# 6. Chạy api, worker và web cùng lúc
pnpm dev
```

Sau đó đăng nhập tại web bằng `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` đã khai báo trong `.env`.

## Địa chỉ dev

| Dịch vụ             | URL                                                 |
| ------------------- | --------------------------------------------------- |
| Web (hộp thư)       | http://localhost:3100                               |
| API — healthcheck   | http://localhost:4000/health                        |
| API — cờ tính năng  | http://localhost:4000/config                        |
| Mailpit (xem email) | http://localhost:8025                               |
| S3 (SeaweedFS)      | http://localhost:8333 (bucket `dezon-inbox`)        |
| Postgres            | `postgres://dezon:dezon@localhost:5433/dezon_inbox` |
| Redis               | `redis://localhost:6379`                            |

### API hộp thư (Giai đoạn 1A)

Mặc định cần `Authorization: Bearer <access token>`. DTO/schema ở `packages/shared/src/inbox.ts`, sự kiện realtime ở `packages/shared/src/realtime.ts`.

| Endpoint                                                                 | Ghi chú                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `GET/POST /webhooks/messenger`                                           | Công khai; kiểm verify token / chữ ký rồi đẩy job `inbound`    |
| `GET /conversations`, `GET /conversations/:id`                           | Theo quyền: admin xem tất cả, agent xem của mình + chưa giao   |
| `GET/POST /conversations/:id/messages`                                   | Phân trang cursor; gửi tin => job `outbound`                   |
| `POST /conversations/:id/read`, `PATCH /conversations/:id`               | Đánh dấu đã đọc; đổi trạng thái / phân công                    |
| `PATCH /contacts/:id`                                                    | Tên, ghi chú, tag của khách                                    |
| `GET /channels`; `POST /channels/messenger`, `PATCH /channels/:id`, `POST /channels/:id/disconnect` | Xem: mọi nhân viên; thêm (dán Page Access Token)/sửa/ngắt: chỉ admin |
| `POST /channels/messenger/oauth/start`                                   | Admin; trả `authorizeUrl` để mở Facebook Login                 |
| `GET /channels/messenger/oauth/callback`                                 | Công khai (Facebook chuyển về, xác thực bằng `state`); 302 về `/admin/channels?fbSession=...` |
| `GET /channels/messenger/oauth/sessions/:id`, `POST .../sessions/:id/connect` | Admin; xem danh sách Trang trong phiên đăng nhập, kết nối các Trang đã chọn |
| `POST /channels/:id/sync`                                                | Admin; body `{days?: 1..365}` (mặc định `MESSENGER_HISTORY_DAYS`) => 202 + `ChannelAccountDto`, đồng bộ lịch sử Messenger ở nền; 409 khi đang đồng bộ, 422 kênh không phải Messenger / chưa kết nối |
| `GET /users/directory`                                                   | Nhân viên đang hoạt động (id, tên, vai trò)                    |
| `POST /media/uploads`                                                    | multipart, field `file`, tối đa `MEDIA_MAX_UPLOAD_MB`          |
| Socket.IO `/socket.io`                                                   | `auth: { token }`; sự kiện `message.created/updated`, `conversation.updated` |

Thiếu cấu hình Meta (`META_*`) hoặc S3 (`S3_*`) thì app vẫn chạy; endpoint liên quan trả 503.

### Kết nối Facebook (Meta App)

- Thử toàn bộ 1A **không cần App thật** (mock Graph + bộ nghiệm thu) và các bước tạo/cấu hình App thật (Webhook, Valid OAuth Redirect URI `<API_URL>/channels/messenger/oauth/callback`, quyền, App Review): [`docs/TESTING-1A.md`](./docs/TESTING-1A.md).
- Dữ kiện Messenger Platform đã kiểm chứng (version, payload webhook, Send API, mã lỗi, cửa sổ 24 giờ, Facebook Login) và các điểm còn phải thử trên sandbox: [`docs/research/messenger-platform.md`](./docs/research/messenger-platform.md).
- Biến môi trường: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (v26.0), `META_HUMAN_AGENT_ENABLED`, tuỳ chọn `META_LOGIN_CONFIG_ID`; `META_GRAPH_BASE_URL` / `META_LOGIN_DIALOG_BASE_URL` chỉ đổi khi trỏ sang mock. **Không ghi giá trị Meta giả vào `.env`**: khi thử với mock, truyền qua biến môi trường của shell.
- Đồng bộ hội thoại (Conversations API, bổ sung cho webhook — kéo cả lịch sử và tin của khách mà webhook không gửi): `MESSENGER_HISTORY_DAYS` (30) = số ngày lịch sử khi kết nối Page và mặc định của nút "Đồng bộ lịch sử"; `MESSENGER_SYNC_INTERVAL_SEC` (60) = chu kỳ đồng bộ định kỳ, `0` = tắt. Cách hoạt động và giới hạn ở chế độ Phát triển: [`docs/TESTING-1A.md`](./docs/TESTING-1A.md) §7.

### Cổng và lý do

Một số cổng mặc định thường đã bị phần mềm khác chiếm trên máy dev (Postgres cài sẵn dùng 5432, nhiều dự án Node/Next dùng 3000, MinIO/Portainer… dùng 9000), nên dự án dùng cổng riêng:

| Thành phần | Cổng host | Đổi bằng biến                                    |
| ---------- | --------- | ------------------------------------------------ |
| Web        | 3100      | `WEB_PORT`, `APP_URL`                            |
| API        | 4000      | `API_PORT`, `API_URL`, `NEXT_PUBLIC_API_URL`     |
| Postgres   | 5433      | `POSTGRES_HOST_PORT` (+ sửa `DATABASE_URL`)      |
| Redis      | 6379      | `REDIS_HOST_PORT` (+ sửa `REDIS_URL`)            |
| S3         | 8333      | `S3_HOST_PORT` (+ sửa `S3_ENDPOINT`)             |
| Mailpit    | 1025/8025 | `MAILPIT_SMTP_HOST_PORT`, `MAILPIT_UI_HOST_PORT` |

Các biến `*_HOST_PORT` được `docker compose` đọc từ `.env` hoặc từ shell.

> Dev dùng **SeaweedFS** thay cho MinIO (MinIO đã ngừng phát hành image công khai). Prod dùng Cloudflare R2 hoặc AWS S3. Xem [`docs/DECISIONS.md`](./docs/DECISIONS.md).

## Lệnh thường dùng

Chạy ở thư mục gốc; Turborepo tự build các package phụ thuộc trước.

| Lệnh                | Tác dụng                                                     |
| ------------------- | ------------------------------------------------------------ |
| `pnpm dev`          | Chạy api, worker, web ở chế độ watch                         |
| `pnpm build`        | Build toàn bộ workspace                                      |
| `pnpm lint`         | ESLint cho mọi package                                       |
| `pnpm typecheck`    | `tsc --noEmit` cho mọi package                               |
| `pnpm test`         | Vitest (test tích hợp dùng Testcontainers, cần Docker chạy)  |
| `pnpm format`       | Định dạng code bằng Prettier                                 |
| `pnpm format:check` | Kiểm tra định dạng (CI dùng lệnh này)                        |
| `pnpm db:generate`  | Sinh migration SQL từ Drizzle schema                         |
| `pnpm db:migrate`   | Chạy migration lên `DATABASE_URL`                            |
| `pnpm db:seed`      | Tạo tài khoản admin (và agent nếu khai báo) từ biến `SEED_*` |

Chạy riêng một package: `pnpm --filter @dezon/api test`, `pnpm --filter @dezon/db db:studio`…

### Script kiểm thử Messenger (`scripts/`)

Chạy bằng `tsx` của worker (`pnpm --filter @dezon/worker exec tsx ../../scripts/<file>.ts`, thêm `--help` để xem tuỳ chọn). Chi tiết: [`docs/TESTING-1A.md`](./docs/TESTING-1A.md).

| Script                  | Tác dụng                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `mock-graph.ts`         | Mock Graph API cổng 4900 (Page, Send API, hồ sơ khách, `subscribed_apps`, Facebook Login), 2 Fanpage test |
| `e2e-1a.ts`             | Bộ nghiệm thu 1A tự động trên mock (REST + Socket.IO + webhook đã ký + Postgres); `--webhook-only` để thử worker tắt |
| `simulate-messenger.ts` | Gửi tay một webhook Messenger đã ký (text, ảnh, echo, delivery, read)                                     |

## Cấu trúc repo

```
dezon-inbox/
├─ apps/
│  ├─ api/                    # NestJS (Fastify): REST, webhook, Socket.IO
│  ├─ worker/                 # BullMQ processors (debounce, AI, gửi tin, refresh token)
│  ├─ zalo-personal-worker/   # process riêng chạy zca-js (Giai đoạn 1C, chưa làm)
│  └─ web/                    # Next.js: hộp thư
├─ packages/
│  ├─ core/                   # lõi nghiệp vụ dùng chung api + worker: connector, policy, hộp thư, kênh, media, pipeline
│  ├─ db/                     # Drizzle schema + migrations + seed
│  ├─ shared/                 # types, zod schemas, DTO, sự kiện realtime, tiện ích dùng chung
│  └─ ai-evals/               # bộ test chất lượng câu trả lời AI (Giai đoạn 2, chưa làm)
├─ scripts/                   # mock Graph, bộ nghiệm thu e2e, giả lập webhook Messenger
├─ docs/                      # PROGRESS.md, DECISIONS.md, TESTING-1A.md, research/
├─ infra/                     # cấu hình hạ tầng dev (SeaweedFS…)
├─ .github/workflows/ci.yml   # CI: format, lint, typecheck, test, build
├─ docker-compose.yml
└─ .env.example
```

Chi tiết module trong `apps/api/src/modules/` xem mục 4 của đặc tả.

## Tài liệu

- Đặc tả kỹ thuật: [`dezon-omnichannel-ai-spec.md`](./dezon-omnichannel-ai-spec.md)
- Tiến độ theo giai đoạn: [`docs/PROGRESS.md`](./docs/PROGRESS.md)
- Các quyết định lệch khỏi đặc tả: [`docs/DECISIONS.md`](./docs/DECISIONS.md)
- Kiểm thử Giai đoạn 1A và cấu hình Meta App: [`docs/TESTING-1A.md`](./docs/TESTING-1A.md)
- Tra cứu Messenger Platform: [`docs/research/messenger-platform.md`](./docs/research/messenger-platform.md)

## Bảo mật

- Không commit `.env`. Mọi secret đi qua biến môi trường và được validate khi khởi động.
- Token/secret của kênh luôn được mã hóa khi lưu (`ENCRYPTION_KEY`), không trả về client, không ghi ra log.
