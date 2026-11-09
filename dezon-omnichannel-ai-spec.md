
# Dezon Omni Inbox — Đặc tả kỹ thuật để AI lập trình theo giai đoạn

> **Phiên bản:** 1.1 · **Ngày:** 04/11/2026 · **Chủ sản phẩm:** Dezon (dezon.vn)
>
> Tài liệu này viết cho **AI coding agent** (Claude Code, Cursor…) và lập trình viên. Đọc toàn bộ một lần, sau đó **chỉ làm đúng một giai đoạn mỗi lượt**.

---

## 0. Hướng dẫn dành cho AI coding agent

**Quy tắc làm việc — bắt buộc:**

1. Đọc hết tài liệu trước khi viết code. Mục 3 (công nghệ), 5 (dữ liệu) và 6 (luồng xử lý) là "hợp đồng" chung cho mọi giai đoạn.
2. Chỉ làm giai đoạn được yêu cầu (ví dụ: "Làm Giai đoạn 1B"). Không làm trước tính năng của giai đoạn sau.
3. Mỗi giai đoạn kết thúc khi **tất cả tiêu chí nghiệm thu** đều đạt. Viết test cho từng tiêu chí khi có thể.
4. Khi gặp mục đánh dấu **⚠️ XÁC MINH**: đọc tài liệu chính thức của nền tảng (Zalo Developers, Meta for Developers) trước khi code. Nếu thực tế khác tài liệu này, **làm theo tài liệu chính thức** và ghi chú lại vào `docs/DECISIONS.md`.
5. Không hard-code secret. Mọi cấu hình đều đi qua biến môi trường (mục 10) và được validate khi khởi động.
6. Cuối mỗi giai đoạn, cập nhật:
   - `docs/PROGRESS.md`: đã xong gì, còn gì, các nợ kỹ thuật.
   - `docs/DECISIONS.md`: những quyết định đã lệch khỏi đặc tả và lý do.
7. Không xóa dữ liệu hội thoại khi migrate. Migration phải chạy tiến được; viết migration ngược khi hợp lý.
8. Ưu tiên code đơn giản, dễ đọc, có kiểu dữ liệu chặt (TypeScript `strict`). Không thêm thư viện ngoài danh sách mục 3 nếu chưa ghi lý do vào `DECISIONS.md`.

---

## 1. Tổng quan sản phẩm

### 1.1 Mục tiêu

Gom tất cả tin nhắn khách hàng về **một hộp thư duy nhất**:

- Zalo Official Account (OA) của Dezon
- Zalo cá nhân của từng nhân viên sale
- Fanpage Facebook (Messenger)

Mỗi tin có **nhãn kênh rõ ràng**. AI trực 24/7, trả lời đúng giọng thương hiệu, và **biết nhường cho người thật** đúng lúc.

### 1.2 Kịch bản chuẩn (dùng làm test end-to-end)

1. **23:00** — Chị Lan nhắn Fanpage hỏi tư vấn mẫu thiết kế trên dezon.vn, gửi kèm 1 ảnh và nhắn dồn 3 tin liên tiếp.
2. Hệ thống **đợi chị nhắn xong** (debounce), AI đọc cả 3 tin và ảnh, tra kho kiến thức và catalog (giá, tình trạng), rồi trả lời **một lần, gọn**, đúng giọng sale Dezon.
3. Nhân viên mở hội thoại sáng hôm sau thấy toàn bộ luồng chat: tin khách, tin bot, tin nhân viên xen kẽ, phân biệt bằng màu và nhãn.
4. **3 ngày sau** — chị Lan quay lại. AI đã có hồ sơ: chị quan tâm mẫu gì, ngân sách, phong cách. AI không hỏi lại từ đầu.
5. Chị hỏi *"có giảm giá được không?"*. AI nhận ra đây là việc cần người thật: **không trả lời**, tắt AI cho hội thoại này, báo ngay cho nhân viên (Lark và thông báo trong app).
6. Nhân viên gạt công tắc **"Người tiếp quản"** và chat. Xong thì gạt lại **"AI tiếp tục"**.

### 1.3 Người dùng hệ thống

| Vai trò | Quyền |
|---|---|
| `admin` | Quản lý kênh, nhân viên, kho kiến thức, cấu hình AI, xem tất cả hội thoại |
| `agent` (sale) | Xem hội thoại được phân công và hội thoại của tài khoản Zalo cá nhân của mình; trả lời; bật/tắt AI |

---

## 2. Ràng buộc của từng kênh (rất quan trọng)

> ⚠️ **XÁC MINH** toàn bộ mục này với tài liệu chính thức trước khi code connector. Chính sách nền tảng thay đổi thường xuyên.

### 2.1 Zalo OA — chính thức (Zalo OpenAPI)

- **Nhận tin:** webhook. Xác thực bằng header `X-ZEvent-Signature`. ⚠️ XÁC MINH công thức chữ ký (thường là `sha256(appId + rawBody + timestamp + oaSecretKey)`).
- **Gửi tin tư vấn:** `POST https://openapi.zalo.me/v3.0/oa/message/cs`.
- **Cửa sổ gửi** (tính từ tương tác cuối của khách):

  | Khoảng thời gian | Trạng thái |
  |---|---|
  | ≤ 48 giờ | Gửi được, miễn phí |
  | 48 giờ – 7 ngày | Gửi được, **có tính phí** |
  | > 7 ngày | Bị từ chối |

- **Token:** OAuth v4 (PKCE). Có access token và refresh token. ⚠️ XÁC MINH thời hạn. Refresh token **dùng một lần**: mỗi lần refresh phải lưu cặp token mới một cách atomic (transaction và lock), nếu không sẽ mất kết nối OA.
- Nội dung tin tư vấn tối đa khoảng 2000 ký tự mỗi tin.
- Ghi nhận cả tin OA gửi đi từ công cụ khác (sự kiện `oa_send_*`) để luồng chat đầy đủ. ⚠️ XÁC MINH tên sự kiện.

### 2.2 Facebook Messenger (Fanpage) — chính thức (Messenger Platform)

- **Nhận tin:** webhook. Xác thực `GET` bằng `hub.verify_token`/`hub.challenge`. Mọi `POST` kiểm tra `X-Hub-Signature-256` (HMAC-SHA256 với App Secret).
- **Gửi tin:** Send API `POST /{PAGE_ID}/messages`, đặt `messaging_type: RESPONSE`. Phiên bản Graph API lấy từ cấu hình (`META_GRAPH_VERSION`).
- **Cửa sổ 24 giờ** tính từ tin cuối của khách. Mỗi tin mới của khách đặt lại đồng hồ.
- **Ngoại lệ:**
  - Tag `HUMAN_AGENT`: tối đa 7 ngày, **chỉ cho tin do người thật gửi**, cần qua App Review. **Bot tuyệt đối không được dùng tag này.**
  - Hội thoại bắt đầu từ quảng cáo Click-to-Messenger (webhook có `referral.source = ADS`): cửa sổ tiêu chuẩn tối đa 7 ngày tính từ tin đầu tiên. ⚠️ XÁC MINH.
- **Tin echo** (`message.is_echo = true`): là tin do Page gửi đi, kể cả nhân viên trả lời trực tiếp trong Meta Business Suite. Dùng `app_id` của echo để phân biệt: trùng app của mình thì đã lưu rồi (bỏ qua hoặc khớp theo `mid`), khác app thì là nhân viên gửi từ Business Suite, lưu với `sender_type = agent`.

### 2.3 Zalo cá nhân — KHÔNG chính thức

- Zalo không có API chính thức cho tài khoản cá nhân. Hệ thống dùng thư viện `zca-js`, thư viện này giả lập Zalo Web. **Tài khoản có thể bị khóa.**
- Mỗi tài khoản chỉ giữ được **một kết nối listener**. Nhân viên vẫn dùng app điện thoại bình thường, nhưng có thể bị đá khỏi Zalo Web trên máy tính.
- **Chính sách sản phẩm bắt buộc:**
  - Giai đoạn 1 chỉ gom tin và cho nhân viên trả lời, chưa có AI. Từ Giai đoạn 4, mặc định `ai_mode = suggest`: AI chỉ **soạn gợi ý**, nhân viên bấm gửi. Admin có thể bật `auto` cho từng tài khoản, kèm cảnh báo rủi ro rõ ràng trên giao diện.
  - Giới hạn tốc độ gửi (ví dụ tối đa 1 tin mỗi 3 giây, có jitter) và không gửi hàng loạt.
  - Mỗi tài khoản dùng một proxy cố định (tùy chọn) và thiết bị (`imei`/`userAgent`) cố định.
  - Có màn hình **đồng ý của nhân viên** trước khi kết nối tài khoản cá nhân của họ.
- Tách thành **service riêng** (`zalo-personal-worker`) để nếu thư viện hỏng hay bị chặn thì không ảnh hưởng hệ thống chính.

---

## 3. Công nghệ đã chọn và lý do

| Lớp | Lựa chọn | Lý do |
|---|---|---|
| Ngôn ngữ | **TypeScript (Node.js 22 LTS)** cho toàn bộ hệ thống | `zca-js` là thư viện Node, nên dùng một ngôn ngữ cho tất cả, dễ cho AI agent |
| Monorepo | **pnpm workspaces + Turborepo** | Chia sẻ kiểu dữ liệu giữa API, worker, web |
| Backend API | **NestJS** (adapter Fastify) | Cấu trúc module rõ ràng, DI, dễ chia việc theo giai đoạn |
| CSDL | **PostgreSQL 16 + pgvector** | Một CSDL cho cả dữ liệu nghiệp vụ và vector (RAG); không cần thêm vector DB |
| ORM | **Drizzle ORM + drizzle-kit** | Kiểu chặt, hỗ trợ cột `vector`, migration dạng SQL rõ ràng |
| Hàng đợi / hẹn giờ | **Redis 7 + BullMQ** | Debounce tin nhắn, retry gửi tin, refresh token định kỳ |
| Realtime | **Socket.IO** (Redis adapter) | Đẩy tin mới, trạng thái AI tới hộp thư |
| Frontend | **Next.js 15 (App Router) + React + Tailwind CSS + shadcn/ui + TanStack Query** | Phổ biến, AI agent viết tốt, giao diện nhanh |
| Lưu file/ảnh | **S3-compatible**: MinIO (dev), Cloudflare R2 hoặc S3 (prod) | Ảnh khách gửi phải được tải về lưu, vì URL của nền tảng sẽ hết hạn |
| LLM chính | **Claude API — `claude-sonnet-5-5`** | Tiếng Việt tốt, đọc được ảnh, tool calling ổn định |
| LLM phụ | **`claude-haiku-5-5`** | Phân loại ý định, tóm tắt hồ sơ khách, mô tả ảnh catalog: rẻ và nhanh |
| Embedding | **Voyage AI** (model đa ngôn ngữ mới nhất), đặt sau interface `EmbeddingProvider` | Đổi được sang OpenAI hoặc `bge-m3` tự host mà không sửa logic |
| Validate | **Zod** | Validate payload webhook, biến môi trường, output của AI |
| Auth | Email + mật khẩu (argon2), JWT access/refresh, RBAC | Đơn giản, đủ cho nội bộ |
| Thông báo | **Lark custom bot webhook** + thông báo trong app + Web Push | Đội Dezon đang dùng Lark |
| Logging | **pino** (JSON) + **Sentry** | Debug webhook, lỗi AI |
| Test | **Vitest** (unit/integration) + **Playwright** (E2E) + **Testcontainers** (Postgres/Redis) | |
| Triển khai | **Docker Compose** trên VPS (ưu tiên đặt tại Việt Nam hoặc Singapore) + **Caddy** (HTTPS tự động) | Webhook bắt buộc HTTPS; một máy là đủ cho quy mô SME |
| CI | GitHub Actions: lint, typecheck, test, build image | |

**Vì sao không dựng trên Chatwoot?** Chatwoot là Ruby on Rails. Thêm kênh Zalo OA và Zalo cá nhân (Node), cộng với logic debounce và chuyển cho người thật theo ý muốn, sẽ phải sửa sâu vào một codebase khác ngôn ngữ. Tự xây bằng một stack TypeScript cho toàn quyền kiểm soát, và AI agent dễ làm theo từng giai đoạn hơn.

---

## 4. Cấu trúc repo

```
dezon-inbox/
├─ apps/
│  ├─ api/                    # NestJS: REST, webhook, Socket.IO
│  │  └─ src/modules/
│  │     ├─ auth/  users/
│  │     ├─ channels/         # quản lý kết nối kênh
│  │     ├─ connectors/
│  │     │  ├─ messenger/
│  │     │  ├─ zalo-oa/
│  │     │  └─ zalo-personal/ # chỉ là cầu nối HTTP/Redis tới worker
│  │     ├─ inbox/            # contacts, conversations, messages
│  │     ├─ ai/               # orchestrator, prompts, tools
│  │     ├─ knowledge/        # kho kiến thức, RAG
│  │     ├─ catalog/          # adapter dezon.vn (giá, mẫu, tình trạng)
│  │     ├─ memory/           # hồ sơ khách hàng
│  │     ├─ handoff/          # chuyển người thật và thông báo
│  │     └─ media/
│  ├─ worker/                 # BullMQ processors (debounce, AI, gửi tin, token refresh)
│  ├─ zalo-personal-worker/   # process riêng chạy zca-js
│  └─ web/                    # Next.js hộp thư
├─ packages/
│  ├─ db/                     # Drizzle schema + migrations
│  ├─ shared/                 # types, zod schemas, hằng số
│  └─ ai-evals/               # bộ test chất lượng câu trả lời AI
├─ docs/  PROGRESS.md  DECISIONS.md
├─ docker-compose.yml  docker-compose.prod.yml  Caddyfile
└─ .env.example
```

---

## 5. Mô hình dữ liệu (packages/db)

> Mọi bảng có `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at timestamptz`. Kiểu enum dùng `pgEnum`.

```ts
// Enums
channel_type      = 'zalo_oa' | 'messenger' | 'zalo_personal'
sender_type       = 'customer' | 'bot' | 'agent' | 'system'
ai_mode           = 'auto' | 'suggest' | 'off'
conversation_status = 'open' | 'pending_human' | 'resolved'
message_status    = 'received' | 'queued' | 'sent' | 'delivered' | 'seen' | 'failed'
user_role         = 'admin' | 'agent'
```

### Bảng chính

**users** — `email unique, password_hash, name, role, lark_user_id?, is_active`

**channel_accounts** — một dòng cho mỗi OA, mỗi Fanpage, mỗi tài khoản Zalo cá nhân
- `type channel_type`, `display_name` (ví dụ "OA Dezon", "Zalo – Sale Hương")
- `external_id` (oa_id / page_id / zalo uid), `owner_user_id?` (bắt buộc với zalo_personal)
- `credentials jsonb` (**mã hóa** AES-256-GCM bằng `ENCRYPTION_KEY`: token, cookie, imei…)
- `status` ('connected' | 'expired' | 'error' | 'disconnected'), `last_error?`
- `default_ai_mode ai_mode` (zalo_personal mặc định 'suggest')
- `color` (màu nhãn trên giao diện), `settings jsonb`
- unique(`type`, `external_id`)

**contacts** — một người khách (có thể có nhiều danh tính trên nhiều kênh)
- `display_name, phone?, email?, avatar_url?, tags text[], notes?`

**contact_identities** — danh tính của khách trên một kênh cụ thể
- `contact_id fk, channel_account_id fk, external_user_id` (Zalo user_id theo OA / PSID / uid Zalo)
- `profile jsonb`, unique(`channel_account_id`, `external_user_id`)

**conversations** — một luồng chat = một identity × một channel_account
- `contact_id, channel_account_id, contact_identity_id`
- `status conversation_status`, `ai_mode ai_mode`, `ai_paused_until timestamptz?`
- `assigned_user_id?`
- `last_customer_message_at` (**dùng để tính cửa sổ gửi**), `last_message_at`, `unread_count`
- `window_source` ('organic' | 'ads') cho Messenger
- `handoff_reason?`, `handoff_at?`

**messages**
- `conversation_id, sender_type, sender_user_id?` (khi agent)
- `external_message_id?` unique theo channel_account (**chống trùng webhook**)
- `text?`, `attachments jsonb` (`[{type:'image'|'file'|'sticker'|'video'|'audio', storage_key, mime, width?, height?, original_url?}]`)
- `status message_status`, `error?`
- `ai_run_id?` (tin do bot gửi), `reply_to_message_id?`
- `raw jsonb` (payload gốc, xóa sau 90 ngày bằng job)
- `sent_at timestamptz` (thời điểm theo nền tảng)
- index (`conversation_id`, `sent_at`)

**ai_suggestions** — bản nháp AI cho chế độ `suggest`
- `conversation_id, ai_run_id, text, status` ('pending' | 'sent' | 'edited_sent' | 'discarded')

**ai_runs** — log mỗi lần AI xử lý (để debug và đánh giá)
- `conversation_id, trigger_message_ids uuid[], model, input_tokens, output_tokens, latency_ms`
- `decision` ('reply' | 'escalate' | 'no_reply' | 'suggest' | 'error'), `tool_calls jsonb`, `reasoning_summary?`, `error?`

**handoffs** — `conversation_id, reason_code, summary, created_by` ('ai' | user_id), `acknowledged_by?, acknowledged_at?, resolved_at?`

**customer_memories** — hồ sơ dài hạn, mỗi contact một dòng
- `contact_id unique, summary text` (≤ 1200 ký tự), `facts jsonb` (xem 7.6), `updated_from_message_id`, `version int`

**knowledge_documents** — `title, source_type` ('manual' | 'url' | 'file' | 'faq'), `source_ref?, content_md, is_active, tags`
**knowledge_chunks** — `document_id, chunk_index, content, embedding vector(DIM), tokens`
- index HNSW: `embedding vector_cosine_ops`

**style_examples** — mẫu hội thoại hay của đội sale (học giọng văn)
- `customer_text, agent_reply, situation_tag, embedding vector(DIM), approved_by, is_active`

**catalog_items** — bản đệm dữ liệu từ dezon.vn (đồng bộ định kỳ)
- `external_id, sku?, name, url, category, tags text[], price_text?, price_min?, price_max?, availability`
- `image_urls text[], image_captions text[]` (AI mô tả sẵn), `embedding vector(DIM)`, `synced_at`

**audit_logs** — `user_id?, action, entity, entity_id, data jsonb`

---

## 6. Các luồng xử lý cốt lõi

### 6.1 Luồng tin đến (mọi kênh)

```
Webhook/Listener
  → (1) Xác thực chữ ký → trả 200 NGAY (< 1 giây) sau khi đẩy vào queue `inbound`
  → (2) Worker `inbound`: chuẩn hóa thành NormalizedInboundMessage
  → (3) Upsert contact_identity / contact / conversation
  → (4) Chống trùng bằng external_message_id
  → (5) Tải media về S3 (ảnh resize ≤ 1600px), lưu message
  → (6) Cập nhật last_customer_message_at, unread_count; phát socket `message.created`
  → (7) Nếu sender là khách và AI được phép → gọi Debouncer (6.2)
```

```ts
// packages/shared
interface NormalizedInboundMessage {
  channelAccountId: string;
  channelType: ChannelType;
  externalUserId: string;
  externalMessageId: string;
  direction: 'in' | 'out';            // 'out' = echo / tin do OA hoặc chính chủ gửi
  senderType: SenderType;             // xác định bởi connector
  text?: string;
  attachments: InboundAttachment[];   // url tạm của nền tảng
  sentAt: Date;
  profileHint?: { name?: string; avatarUrl?: string };
  referral?: { source: 'ADS' | string; adId?: string };
  raw: unknown;
}
```

### 6.2 Debounce: gom tin nhắn dồn

- Cấu hình: `AI_DEBOUNCE_MS = 12000`, `AI_DEBOUNCE_MAX_WAIT_MS = 45000`.
- Khi tin của khách đến:
  1. `SET debounce:{convId}:last = now`; nếu chưa có `debounce:{convId}:first` thì `SET` (TTL 5 phút).
  2. Thêm job BullMQ `ai-reply` với `jobId = ai:{convId}` và `delay = AI_DEBOUNCE_MS`. Nếu job cùng id đang chờ thì **xóa và tạo lại** (đặt lại đồng hồ).
  3. Khi job chạy: nếu `now - last < AI_DEBOUNCE_MS` **và** `now - first < MAX_WAIT` thì lên lịch lại phần còn thiếu. Ngược lại, xóa các key và xử lý.
- Tin chỉ có ảnh hoặc sticker cũng đặt lại đồng hồ.
- Job AI lấy **tất cả tin khách chưa được AI xử lý** (sau `ai_runs` cuối) làm `trigger_message_ids`.

### 6.3 Điều kiện để AI được chạy

AI chỉ chạy khi **tất cả** đúng:

- `conversation.ai_mode` ∈ {`auto`, `suggest`}
- `ai_paused_until` là null hoặc đã qua
- `status != 'pending_human'`
- Không có tin `agent` nào gửi sau tin khách đầu tiên trong cụm (nhân viên đã nhảy vào)
- Kênh còn trong cửa sổ gửi (6.5), riêng chế độ `suggest` thì không cần
- Không vượt `AI_MAX_AUTO_REPLIES_PER_HOUR` (mặc định 20 mỗi hội thoại, chống vòng lặp với bot của khách)

### 6.4 Chống đua (race) giữa AI và nhân viên

- Ngay **trước khi gửi**, đọc lại conversation (`SELECT … FOR UPDATE`). Nếu `ai_mode` đã đổi, có tin agent mới, hoặc có tin khách mới sau khi AI bắt đầu, thì **hủy kết quả**. Trường hợp có tin khách mới thì để debounce chạy lại.
- Khi nhân viên gửi tin (từ hộp thư, Business Suite echo, hoặc Zalo cá nhân chính chủ): đặt `ai_paused_until = now + AI_PAUSE_AFTER_AGENT_MIN` (mặc định 30 phút), trừ khi nhân viên bấm "AI tiếp tục".

### 6.5 Kiểm tra cửa sổ gửi (ChannelPolicy)

```ts
interface ChannelPolicy {
  canSend(conv: Conversation, by: 'bot' | 'agent', now: Date):
    { allowed: boolean; costly?: boolean; tag?: 'HUMAN_AGENT'; reason?: string };
}
```

- **Messenger:** ≤ 24 giờ thì cho phép. Hội thoại từ quảng cáo thì ≤ 7 ngày (⚠️ XÁC MINH). Từ 24 giờ đến 7 ngày: chỉ `agent`, kèm tag `HUMAN_AGENT` (bật bằng `META_HUMAN_AGENT_ENABLED`). Bot thì không được.
- **Zalo OA:** ≤ 48 giờ thì cho phép. Từ 48 giờ đến 7 ngày thì cho phép, `costly = true`, giao diện cảnh báo và bot **không tự gửi** (trừ khi `ZALO_OA_ALLOW_PAID_BOT=true`). Quá 7 ngày thì chặn.
- **Zalo cá nhân:** luôn cho phép về mặt kỹ thuật, nhưng áp rate limit.
- Giao diện hiển thị đồng hồ còn lại của cửa sổ trên đầu mỗi hội thoại.

### 6.6 Luồng gửi tin

```
UI/AI → tạo message (status=queued) → job `outbound` → connector.send()
  → thành công: status=sent, lưu external_message_id
  → lỗi tạm thời: retry 3 lần (backoff mũ)
  → lỗi vĩnh viễn (hết cửa sổ, token hỏng): status=failed + thông báo
```

Câu trả lời dài được tách thành các tin ≤ 2000 ký tự. AI thường trả 1–3 "bong bóng" ngắn; mỗi bong bóng gửi cách nhau 0,8–1,5 giây cho tự nhiên.

---

## 7. Thiết kế AI

### 7.1 Đầu vào của mỗi lần chạy

1. **System prompt** (7.2), lấy cấu hình từ admin.
2. **Hồ sơ khách** từ `customer_memories` (nếu có).
3. **Lịch sử:** 30 tin gần nhất của hội thoại (có nhãn `[Khách]`, `[Bot]`, `[NV Hương]`), kèm tóm tắt phần cũ hơn nếu dài.
4. **Cụm tin mới** (trigger), gồm ảnh (gửi trực tiếp dạng image block cho model).
5. **Ngữ cảnh RAG:** top 6 chunk kiến thức và top 4 `style_examples` gần nhất với cụm tin mới.
6. **Thông tin kênh:** tên kênh, giờ hiện tại (Asia/Ho_Chi_Minh), giờ làm việc của đội sale.

### 7.2 Mẫu system prompt (lưu ở `apps/api/src/modules/ai/prompts/system.md`, admin sửa được phần {{brand_voice}} và {{policies}})

```
Bạn là trợ lý tư vấn của Dezon (dezon.vn), trò chuyện với khách qua {{channel_name}}.

# Giọng văn
{{brand_voice}}
- Xưng "em", gọi khách theo cách khách tự xưng hoặc "anh/chị".
- Câu ngắn, thân thiện, như nhân viên sale thật nhắn tin. Không gạch đầu dòng dài, không markdown.
- Tối đa 3 tin nhắn ngắn cho mỗi lượt.

# Nguyên tắc dữ liệu
- Giá, tình trạng, thông số: CHỈ dùng kết quả từ công cụ search_catalog / get_item. Không đoán.
- Chính sách, quy trình: chỉ dùng phần KIẾN THỨC bên dưới. Không có thì nói sẽ kiểm tra lại và escalate.
- Không bao giờ tự hứa giảm giá, khuyến mãi, thời gian giao, hoàn tiền ngoài kiến thức.

# Khi nào phải chuyển người thật (gọi tool escalate, KHÔNG trả lời khách)
{{policies}}
- Khách hỏi giảm giá, mặc cả, chiết khấu, giá sỉ đặc biệt.
- Khiếu nại, bức xúc, đe dọa đánh giá xấu, yêu cầu hoàn tiền.
- Khách yêu cầu gặp người thật.
- Câu hỏi ngoài kiến thức và ngoài catalog, hoặc bạn không chắc chắn.
- Khách sẵn sàng chốt đơn hoặc ký hợp đồng (để sale chốt).

# Hồ sơ khách
{{customer_memory}}

# Kiến thức liên quan
{{knowledge_chunks}}

# Ví dụ cách đội sale trả lời
{{style_examples}}

Thời gian hiện tại: {{now}}. Giờ làm việc của đội sale: {{business_hours}}.
Luôn kết thúc lượt bằng đúng MỘT tool: reply, escalate hoặc no_reply.
```

### 7.3 Công cụ (tool calling)

| Tool | Tham số | Ghi chú |
|---|---|---|
| `search_catalog` | `query: string, category?: string, limit?: number` | Vector + từ khóa trên `catalog_items` |
| `get_item` | `external_id: string` | Gọi **trực tiếp** dezon.vn để có giá và tình trạng mới nhất (cache 5 phút) |
| `find_similar_by_image` | `message_attachment_id: string` | Xem 7.5 |
| `search_knowledge` | `query: string` | Khi cần tra thêm ngoài phần đã nạp sẵn |
| `reply` (kết thúc) | `messages: string[] (1–3)`, `suggested_items?: string[]`, `confidence: 0–1` | Nếu `confidence < AI_MIN_CONFIDENCE` (0,6) thì hệ thống chuyển thành escalate |
| `escalate` (kết thúc) | `reason_code: 'discount'\|'complaint'\|'human_request'\|'out_of_scope'\|'closing'\|'low_confidence'\|'other'`, `summary_for_agent: string`, `holding_message?: string` | `holding_message` chỉ gửi khi admin bật `AI_SEND_HOLDING_MESSAGE` (mặc định **tắt**, đúng yêu cầu "im lặng") |
| `no_reply` (kết thúc) | `reason` | Khi khách chỉ gửi "ok", sticker cảm ơn… |

Vòng lặp tool tối đa 5 bước; quá thì đánh dấu `error` và escalate.

### 7.4 Lớp chặn trước (pre-filter, không cần gọi LLM lớn)

Trước khi gọi Sonnet, chạy một bộ phát hiện nhanh: regex tiếng Việt có dấu và không dấu, kèm Haiku phân loại khi cần.

- Từ khóa giảm giá: `giảm giá|bớt|chiết khấu|discount|sale off|có bớt|bớt chút|giá tốt hơn|mặc cả|voucher|giam gia|bot gia`…
- Gặp người thật: `gặp nhân viên|người thật|admin|gọi cho tôi|tư vấn viên`…
- Từ ngữ bức xúc hoặc khiếu nại.

Khớp thì escalate ngay với `reason_code` tương ứng. Danh sách từ khóa admin chỉnh được trong giao diện.

### 7.5 Đọc ảnh khách gửi

- **Đồng bộ catalog:** mỗi ảnh mẫu được Haiku mô tả (phong cách, màu, bố cục, loại thiết kế) thành `image_captions`, rồi embedding vào `catalog_items.embedding`.
- **Khi khách gửi ảnh:** Sonnet nhìn ảnh trực tiếp. Tool `find_similar_by_image` mô tả ảnh khách bằng cùng prompt caption, embedding, rồi tìm top 5 mẫu giống nhất (cosine) và trả về `{external_id, name, url, score}`.
- Score dưới ngưỡng thì AI nói không thấy mẫu y hệt và gợi ý mẫu gần nhất. Không bịa tên mẫu.

### 7.6 Bộ nhớ khách hàng

- **Kích hoạt:** job `memory-update` khi hội thoại im lặng 30 phút sau tin cuối, hoặc khi `resolved`.
- Haiku đọc hồ sơ cũ cùng các tin mới và trả về JSON (validate bằng Zod):

```json
{
  "summary": "Chị Lan, chủ shop mỹ phẩm ở Đà Nẵng, cần thiết kế bộ nhận diện...",
  "facts": {
    "preferred_name": "chị Lan",
    "interests": [{"item_id": "123", "name": "Mẫu logo X", "last_mentioned": "2026-11-04"}],
    "budget": "khoảng 5–8 triệu",
    "style_preferences": ["tối giản", "tông pastel"],
    "stage": "tham khảo",
    "objections": ["lo thời gian làm lâu"],
    "contact_info": {"phone": null},
    "do_not": ["không gọi điện, chỉ nhắn tin"]
  }
}
```

- Nhân viên **xem và sửa** được hồ sơ ở cột phải của hội thoại.
- Hồ sơ gắn với `contact`, nên khi gộp danh tính (cùng số điện thoại) thì dùng chung trên mọi kênh.

### 7.7 Học giọng văn từ đội sale

- Màn hình admin "Mẫu giọng văn": chọn tin nhân viên trong các hội thoại cũ, ghép thành cặp (tin khách → câu trả lời hay), gắn `situation_tag`, duyệt.
- Có nút "Gợi ý mẫu": Haiku đề xuất các cặp hay từ lịch sử, admin duyệt.
- Trường `brand_voice` (văn bản tự do) trong cấu hình AI, ví dụ: "Nhiệt tình, dùng 'dạ', 'ạ', không dùng emoji quá 1 cái mỗi tin…"
- Chế độ `suggest`: nếu nhân viên **sửa** bản nháp trước khi gửi, lưu cặp (nháp, bản sửa) để admin duyệt làm `style_example` mới.

### 7.8 Đánh giá chất lượng (packages/ai-evals)

- Bộ ít nhất 40 tình huống dạng YAML: đầu vào (lịch sử, tin, ảnh tùy chọn) và kỳ vọng (`decision`, phải có hoặc không được có cụm từ, `reason_code`).
- Bắt buộc có: hỏi giá có trong catalog; hỏi giảm giá (escalate); nhắn dồn 3 tin; gửi ảnh mẫu; khách cũ quay lại; câu ngoài phạm vi; khách chỉ nói "ok".
- Lệnh `pnpm eval` chạy trên model thật và in tỉ lệ đạt. Chạy lại khi đổi prompt.

---

## 8. Giao diện hộp thư (apps/web)

**Bố cục 3 cột:**

1. **Danh sách hội thoại:** bộ lọc theo kênh và tài khoản (chip màu), trạng thái (`Cần người`, `AI đang lo`, `Đã xong`), người phụ trách, chưa đọc. Mỗi dòng: avatar, tên, **nhãn kênh màu**, trích tin cuối, giờ, badge ⚠️ khi `pending_human`.
2. **Khung chat:**
   - Header: tên khách, nhãn kênh, đồng hồ cửa sổ gửi, **công tắc lớn "🤖 AI tự trả lời / 👤 Người tiếp quản"** (và "Gợi ý" với Zalo cá nhân).
   - Tin khách bên trái. Tin bot bên phải, nền tím nhạt, nhãn "AI". Tin nhân viên bên phải, nền xanh, tên nhân viên. Tin hệ thống ở giữa ("AI đã chuyển cho người thật: hỏi giảm giá").
   - Bản nháp AI (chế độ suggest) hiển thị trên ô soạn tin: nút **Gửi** / **Sửa** / **Bỏ**.
   - Ô soạn: văn bản, đính kèm ảnh, chèn link mẫu từ catalog.
3. **Cột thông tin:** hồ sơ khách (memory, sửa được), các danh tính trên nhiều kênh, mẫu đã quan tâm, nhật ký AI (lần chạy, quyết định, tool đã gọi; chỉ admin).

**Trang admin:** Kênh (kết nối OA, Fanpage, Zalo cá nhân bằng QR), Nhân viên, Kho kiến thức, Mẫu giọng văn, Cấu hình AI (prompt, từ khóa escalate, giờ làm việc, ngưỡng), Catalog (đồng bộ ngay), Thống kê.

Giao diện tiếng Việt, responsive (nhân viên dùng điện thoại), có thể cài như PWA để nhận Web Push.

---

## 9. Các giai đoạn triển khai

> Mỗi bước là một lượt giao việc cho AI agent. Câu lệnh mẫu: **"Đọc `dezon-omnichannel-ai-spec.md`, làm Giai đoạn 1A. Dừng khi đạt tiêu chí nghiệm thu."**
>
> **Ưu tiên của chủ sản phẩm:** gom tin nhắn từ mọi kênh về một hộp thư để nhân viên xem và trả lời được **trước**. Hết Giai đoạn 1, hệ thống phải dùng được hằng ngày, **chưa có AI**. AI bắt đầu từ Giai đoạn 2.

### Tổng quan

| Giai đoạn | Nội dung | Kết quả dùng được |
|---|---|---|
| **0** | Nền móng | Đăng nhập, khung giao diện |
| **1A** | Hộp thư hợp nhất + Fanpage Facebook | Xem và trả lời tin Fanpage |
| **1B** | Zalo OA | Xem và trả lời tin Zalo OA |
| **1C** | Zalo cá nhân của nhân viên | Xem và trả lời tin Zalo cá nhân |
| **1D** | Hoàn thiện để chạy thật | Đội sale dùng hằng ngày trên môi trường thật |
| **2** | AI tự trả lời + chuyển người thật | AI trực 24/7, biết nhường người |
| **3** | AI đọc ảnh + nhớ khách hàng | Nhận mẫu từ ảnh, không hỏi lại khách cũ |
| **4** | AI cho Zalo cá nhân + thống kê | AI gợi ý trên Zalo cá nhân, báo cáo hiệu quả |

**Quy tắc chung cho Giai đoạn 0–1:**
- Schema dữ liệu tạo **đầy đủ theo mục 5** ngay từ Giai đoạn 0, kể cả các bảng AI, để không phải đổi cấu trúc lớn về sau. Các bảng AI chưa dùng thì để trống.
- Mọi hội thoại có `ai_mode = 'off'` trong Giai đoạn 1. **Ẩn** toàn bộ phần giao diện liên quan AI (công tắc AI, nhật ký AI, kho kiến thức) bằng cờ `FEATURE_AI_ENABLED=false`.
- Không cài module `ai`, `knowledge`, `catalog`, `memory` trong Giai đoạn 1.

---

### Giai đoạn 0 — Nền móng

**Việc cần làm**
- Khởi tạo monorepo (mục 4), TypeScript strict, ESLint, Prettier, Turborepo.
- `docker-compose.yml` dev: Postgres 16 (có pgvector), Redis 7, MinIO, Mailpit.
- `packages/db`: Drizzle schema **đầy đủ mục 5** và migration đầu tiên (`CREATE EXTENSION vector`).
- `apps/api`: NestJS + Fastify, config module (Zod validate env), healthcheck `/health`, pino logger, auth (đăng nhập, refresh, RBAC), seed 1 admin.
- `apps/worker`: khung BullMQ và một job mẫu.
- `apps/web`: Next.js, trang đăng nhập, layout 3 cột rỗng.
- Tiện ích mã hóa `encrypt/decrypt` cho `credentials`.
- Cờ tính năng `FEATURE_AI_ENABLED`, `ZALO_PERSONAL_ENABLED` đọc từ env và trả về cho web qua `/config`.
- GitHub Actions: lint, typecheck, test.

**Nghiệm thu**
- [ ] `docker compose up` và `pnpm dev` chạy được cả api, worker, web.
- [ ] Đăng nhập bằng admin seed, nhận JWT; tài khoản `agent` bị chặn ở route chỉ dành cho admin.
- [ ] Migration chạy sạch trên DB trống; test mã hóa/giải mã đạt.
- [ ] CI xanh.

---

### Giai đoạn 1A — Hộp thư hợp nhất + Fanpage Facebook

**Việc cần làm**
- Module `inbox`: API danh sách hội thoại (lọc theo kênh, tài khoản kênh, trạng thái, người phụ trách, chưa đọc), chi tiết hội thoại, phân trang tin (cursor), gửi tin, đánh dấu đã đọc, phân công nhân viên, đổi trạng thái `open`/`resolved`.
- Socket.IO (Redis adapter, xác thực JWT): sự kiện `message.created`, `message.updated`, `conversation.updated`.
- Pipeline inbound (6.1, **bỏ bước 7 gọi AI**) và outbound (6.6) dùng chung cho mọi connector, qua interface:

```ts
interface ChannelConnector {
  type: ChannelType;
  parseWebhook(req): Promise<NormalizedInboundMessage[]>;
  verifyWebhook(req): boolean;
  send(account: ChannelAccount, to: ContactIdentity, msg: OutboundMessage): Promise<{ externalMessageId: string }>;
  fetchProfile?(account, externalUserId): Promise<{ name?: string; avatarUrl?: string }>;
}
```

- Connector **Messenger**, hỗ trợ **nhiều Fanpage** (mỗi Page một `channel_account`):
  - Xác thực webhook.
  - Xử lý `messages` (text, ảnh, file, sticker), `message_echoes`, `message_deliveries`, `message_reads`, `referral`.
  - Tin echo (2.2): tin nhân viên trả lời từ Meta Business Suite cũng được lưu, với `sender_type = agent`.
  - Lấy tên và avatar khách qua Graph API.
  - Kết nối Page: admin dán Page Access Token dài hạn, hoặc dùng OAuth Facebook Login (tùy chọn).
- Tải media về S3, phục vụ qua URL ký có thời hạn.
- `ChannelPolicy` cho Messenger (6.5): đồng hồ cửa sổ 24 giờ.
- Trang admin **Kênh**: thêm, sửa, ngắt kết nối Fanpage; đặt tên hiển thị và **màu nhãn**.
- UI hộp thư (mục 8, không có phần AI): danh sách hội thoại, khung chat realtime, gửi văn bản và ảnh, nhãn kênh màu, đồng hồ cửa sổ gửi, cột thông tin khách (tên, kênh, ghi chú, tag).

**Nghiệm thu**
- [ ] Kết nối 2 Fanpage test; tin nhắn vào mỗi Page hiện trong hộp thư trong ≤ 3 giây, đúng tên và avatar khách, **đúng nhãn và màu của từng Page**.
- [ ] Trả lời từ hộp thư thì khách nhận được trên Messenger.
- [ ] Nhân viên trả lời từ Meta Business Suite: tin vẫn hiện trong hộp thư là tin nhân viên, không bị trùng.
- [ ] Ảnh khách gửi xem được trong hộp thư kể cả sau khi URL gốc của Facebook hết hạn.
- [ ] Gửi webhook trùng 2 lần thì chỉ lưu 1 tin.
- [ ] Quá 24 giờ thì nút gửi bị khóa kèm lý do (khi `META_HUMAN_AGENT_ENABLED=false`).
- [ ] Webhook trả 200 trong < 1 giây kể cả khi worker tắt; tin được xử lý khi worker bật lại.
- [ ] Hai nhân viên mở cùng một hội thoại thì đều thấy tin mới realtime.

---

### Giai đoạn 1B — Zalo OA

**Việc cần làm**
- OAuth v4 với PKCE để kết nối OA (hỗ trợ nhiều OA); lưu token mã hóa.
- Job `zalo-oa-token-refresh` chạy định kỳ: refresh trước khi hết hạn, dùng **lock Redis và transaction** (refresh token dùng một lần). Lỗi thì `status = expired` và hiện cảnh báo đỏ trong trang Kênh và đầu hộp thư.
- Webhook: xác thực `X-ZEvent-Signature` (⚠️ XÁC MINH), xử lý tin text, ảnh, file, sticker, follow/unfollow, và các sự kiện OA gửi đi (tin gửi từ công cụ khác cũng vào luồng chat).
- Gửi tin tư vấn: text và ảnh (upload ảnh lấy `attachment_id` hoặc dùng URL, ⚠️ XÁC MINH).
- Lấy hồ sơ người quan tâm (tên, avatar, số điện thoại nếu khách đã chia sẻ).
- `ChannelPolicy` Zalo OA (48 giờ / 7 ngày, cờ `costly`): giao diện cảnh báo "Tin này có phí" trước khi gửi.

**Nghiệm thu**
- [ ] Kết nối OA bằng OAuth trong trang admin, trạng thái `connected`.
- [ ] Tin đến OA hiện trong hộp thư với nhãn "Zalo OA – {tên OA}"; trả lời được, kể cả gửi ảnh.
- [ ] Test giả lập: chạy refresh token song song 2 lần thì chỉ có một lần gọi Zalo, token mới được lưu đúng.
- [ ] Hội thoại ở mốc 50 giờ thì hiện cảnh báo có phí; quá 7 ngày thì chặn gửi.
- [ ] Chữ ký sai thì trả 401 và không lưu tin.

---

### Giai đoạn 1C — Zalo cá nhân của nhân viên

> Đọc kỹ mục 2.3 trước khi làm. Đây là tích hợp **không chính thức**.

**Việc cần làm**
- `apps/zalo-personal-worker`: một process quản lý nhiều phiên `zca-js` (mỗi tài khoản một instance), giao tiếp với API qua Redis Streams.
- Luồng kết nối:
  1. Nhân viên vào "Kết nối Zalo của tôi".
  2. Đọc và **bấm đồng ý điều khoản rủi ro**; hệ thống lưu bằng chứng đồng ý (thời gian, IP).
  3. Quét QR hiển thị trên web.
  4. Lưu cookie, imei và userAgent (mã hóa).
- Nhận tin 1–1 (bỏ qua tin nhóm ở bản đầu, cấu hình được). Tin chính chủ gửi từ điện thoại được lưu là `agent` với `sender_user_id = owner` (cần `selfListen`, ⚠️ XÁC MINH).
- Gửi text và ảnh qua hàng đợi riêng cho từng tài khoản, có rate limit và jitter (`ZALO_PERSONAL_MIN_SEND_INTERVAL_MS`).
- Theo dõi sức khỏe phiên: mất kết nối thì thử lại có backoff; quá 3 lần thì `status = error`, báo chủ tài khoản quét QR lại (thông báo trong app).
- Quyền xem: nhân viên **chỉ thấy** hội thoại Zalo cá nhân của mình; admin thấy tất cả, và mỗi lần admin mở được ghi vào `audit_logs`.
- Nhãn kênh: "Zalo – {tên nhân viên}", màu riêng.

**Nghiệm thu**
- [ ] Nhân viên quét QR thì kết nối thành công; tin đến hiện với nhãn "Zalo – {tên NV}".
- [ ] Nhân viên nhắn từ điện thoại thì tin hiện trong hộp thư là tin nhân viên.
- [ ] Trả lời từ hộp thư thì khách nhận được trên Zalo.
- [ ] Nhân viên A không thấy hội thoại Zalo cá nhân của nhân viên B.
- [ ] Kill `zalo-personal-worker`: API, Fanpage và Zalo OA vẫn chạy; worker tự khởi động lại và nối lại phiên.
- [ ] Gửi 10 tin liên tiếp thì giãn cách đúng rate limit.

---

### Giai đoạn 1D — Hoàn thiện để chạy thật (chưa có AI)

**Việc cần làm**
- **Thông báo tin mới:** trong app (âm thanh, badge, tiêu đề tab), Web Push (PWA). Thông báo Lark (tùy chọn) khi một hội thoại chưa được trả lời quá `UNANSWERED_ALERT_MIN` phút trong giờ làm việc.
- **Gộp khách hàng:** cùng số điện thoại trên nhiều kênh thì gợi ý gộp; admin xác nhận; có nút "Tách". Cột thông tin hiển thị mọi danh tính của khách, kèm link nhảy qua các hội thoại khác của cùng khách.
- **Tìm kiếm** theo tên khách, số điện thoại, nội dung tin (Postgres full-text + `unaccent`, tìm được cả tiếng Việt không dấu).
- **Trả lời nhanh:** mẫu câu soạn sẵn, gõ `/` để chèn.
- Giao diện điện thoại (responsive) và cài được như PWA.
- Trang admin **Nhân viên**: thêm, khóa tài khoản, phân quyền.
- Vận hành:
  - `docker-compose.prod.yml`, Caddyfile (HTTPS cho webhook), `docs/DEPLOY.md`.
  - Backup Postgres hằng ngày lên S3 (giữ 14 bản) và hướng dẫn khôi phục.
  - Sentry, rate limit API, giới hạn kích thước upload.
  - Job xóa `raw` sau 90 ngày.

**Nghiệm thu**
- [ ] Triển khai trên VPS trống theo `DEPLOY.md` trong ≤ 30 phút; webhook Facebook và Zalo OA hoạt động qua HTTPS thật.
- [ ] Trên điện thoại, nhân viên nhận Web Push khi có tin mới, bấm vào thì mở đúng hội thoại.
- [ ] Tìm "lan" hoặc "chị lan" ra hội thoại của chị Lan ở mọi kênh.
- [ ] Gộp 2 danh tính của cùng khách thì cột thông tin hiện cả 2 kênh.
- [ ] Khôi phục từ backup thành công trên môi trường thử.
- [ ] **Đội sale dùng thử 1 tuần trên dữ liệu thật** trước khi bắt đầu Giai đoạn 2.

---

### Giai đoạn 2 — AI tự trả lời + chuyển người thật

> Áp dụng cho Fanpage và Zalo OA. Zalo cá nhân **chưa bật AI** ở giai đoạn này.
> Bật `FEATURE_AI_ENABLED=true`. Migration đặt `default_ai_mode` của Fanpage và OA thành `auto` (admin chỉnh được).
> Đọc lại mục 6.2–6.5 và mục 7.

**Việc cần làm**
- Module `knowledge`: CRUD tài liệu (markdown), nhập từ URL (đọc trang dezon.vn) và file (PDF, DOCX, TXT); chunk khoảng 500 token, chồng lấn 15%; embedding; tìm kiếm hybrid (vector + full-text không dấu).
- Module `catalog`: interface `CatalogProvider`, bản cài đặt đầu tiên cho dezon.vn (⚠️ XÁC MINH cấu trúc dữ liệu; xem mục 12). Job đồng bộ mỗi 6 giờ và nút "Đồng bộ ngay".
- Module `ai`: Debouncer (6.2), điều kiện chạy (6.3), orchestrator (7.1–7.3), pre-filter (7.4), chống đua (6.4), lưu `ai_runs`.
- **Chuyển người thật** (bắt buộc đi cùng AI, không tách ra giai đoạn sau):
  - Khi escalate: `status = pending_human`, `ai_mode = off`, tạo `handoffs`, tin hệ thống trong hội thoại, sự kiện socket.
  - Thông báo: thẻ Lark (tên khách, kênh, lý do, tóm tắt, nút "Mở hội thoại"), thông báo trong app, Web Push.
  - Người nhận: người phụ trách hội thoại nếu có, không thì nhóm trực. Sau `HANDOFF_ESCALATE_AFTER_MIN` (15 phút) chưa ai nhận thì nhắc lại cả nhóm.
  - Nút "Nhận xử lý" và "Đã xong, trả lại cho AI".
- Hiện phần giao diện AI: **công tắc "🤖 AI tự trả lời / 👤 Người tiếp quản"** trên đầu hội thoại, tin bot nền tím nhãn "AI", bộ lọc "Cần người" / "AI đang lo", nhật ký AI (chỉ admin).
- Trang admin: Kho kiến thức, Catalog, Cấu hình AI (prompt, từ khóa escalate, giờ làm việc, ngưỡng), Mẫu giọng văn (7.7).
- `packages/ai-evals` với ít nhất 25 tình huống.

**Nghiệm thu**
- [ ] Gửi 3 tin liên tiếp cách nhau 4 giây thì AI trả lời **một lần** sau khi tin cuối im khoảng 12 giây, nội dung bao quát cả 3 tin.
- [ ] Hỏi giá một mẫu có trong catalog: giá trả lời khớp đúng dezon.vn (log có tool `get_item`).
- [ ] Hỏi điều không có trong kiến thức: AI không bịa, mà escalate (`out_of_scope`).
- [ ] Khách hỏi "có giảm giá được không?" (và biến thể không dấu "co giam gia ko"): AI **không gửi gì**, hội thoại chuyển "Cần người", Lark nhận thẻ trong ≤ 5 giây.
- [ ] Gạt "Người tiếp quản" thì AI không trả lời tin tiếp theo; gạt lại thì AI trả lời.
- [ ] Nhân viên nhắn (từ hộp thư hoặc từ Business Suite) trong lúc AI đang xử lý: câu trả lời AI bị hủy.
- [ ] Không ai nhận handoff sau 15 phút thì có thông báo nhắc lại.
- [ ] `pnpm eval` đạt ≥ 85%; trung vị độ trễ (sau debounce) ≤ 8 giây.

---

### Giai đoạn 3 — AI đọc ảnh + nhớ khách hàng

**Việc cần làm**
- Caption ảnh catalog bằng Haiku và embedding (7.5); job chạy lại khi catalog đổi.
- Tool `find_similar_by_image`; gửi ảnh khách trực tiếp cho Sonnet (tối đa 4 ảnh mỗi lượt, resize trước).
- Bộ nhớ khách hàng (7.6): job cập nhật, nạp vào prompt, UI xem và sửa ở cột thông tin, lịch sử phiên bản.
- Thêm tình huống eval: ảnh mẫu, khách quay lại sau 3 ngày.

**Nghiệm thu**
- [ ] Gửi ảnh chụp màn hình một mẫu trên dezon.vn: AI nhận đúng mẫu (top-1) trong ≥ 80% bộ test ảnh (ít nhất 15 ảnh).
- [ ] Gửi ảnh không liên quan: AI không bịa tên mẫu.
- [ ] Hội thoại 1 nói ngân sách và phong cách; 3 ngày sau (giả lập thời gian), ở hội thoại 2 AI nhắc lại đúng, không hỏi lại ngân sách.
- [ ] Nhân viên sửa hồ sơ thì lần chạy AI kế tiếp dùng bản đã sửa.

---

### Giai đoạn 4 — AI cho Zalo cá nhân + thống kê

**Việc cần làm**
- Bật AI cho Zalo cá nhân ở chế độ mặc định `suggest`: AI soạn nháp, giao diện có nút **Gửi / Sửa / Bỏ**. Bản nháp bị sửa trước khi gửi thì lưu làm ứng viên `style_examples`.
- Admin bật `auto` cho từng tài khoản Zalo cá nhân, kèm hộp xác nhận rủi ro (2.3).
- AI tạm dừng khi chính chủ nhắn từ điện thoại (6.4).
- Thống kê: số hội thoại theo kênh, thời gian phản hồi đầu tiên (trước và sau khi có AI), tỉ lệ AI tự xử lý, tỉ lệ escalate theo lý do, chi phí token theo ngày.
- Mở rộng eval lên 40 tình huống.

**Nghiệm thu**
- [ ] Chế độ suggest: AI tạo nháp, không tự gửi; bấm Gửi thì khách nhận được.
- [ ] Nhân viên sửa nháp rồi gửi thì cặp (nháp, bản sửa) xuất hiện trong danh sách chờ duyệt ở trang Mẫu giọng văn.
- [ ] Dashboard hiện đúng số liệu trên dữ liệu seed.
- [ ] `pnpm eval` đạt ≥ 85% trên 40 tình huống.

---

## 10. Biến môi trường (`.env.example`)

```bash
# Chung
NODE_ENV=development
APP_URL=https://inbox.dezon.vn
API_URL=https://api-inbox.dezon.vn
TZ=Asia/Ho_Chi_Minh
ENCRYPTION_KEY=            # 32 bytes base64
JWT_SECRET=
JWT_REFRESH_SECRET=

# Hạ tầng
DATABASE_URL=postgres://...
REDIS_URL=redis://...
S3_ENDPOINT=  S3_BUCKET=  S3_ACCESS_KEY=  S3_SECRET_KEY=  S3_REGION=auto

# AI
ANTHROPIC_API_KEY=
AI_MODEL_MAIN=claude-sonnet-5-5
AI_MODEL_FAST=claude-haiku-5-5
EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=
EMBEDDING_MODEL=
EMBEDDING_DIM=1024
AI_DEBOUNCE_MS=12000
AI_DEBOUNCE_MAX_WAIT_MS=45000
AI_PAUSE_AFTER_AGENT_MIN=30
AI_MIN_CONFIDENCE=0.6
AI_MAX_AUTO_REPLIES_PER_HOUR=20
AI_SEND_HOLDING_MESSAGE=false

# Meta / Messenger
META_APP_ID=
META_APP_SECRET=
META_VERIFY_TOKEN=
META_GRAPH_VERSION=        # ⚠️ dùng phiên bản hiện hành
META_HUMAN_AGENT_ENABLED=false

# Zalo OA
ZALO_APP_ID=
ZALO_APP_SECRET=
ZALO_OA_SECRET_KEY=        # dùng xác thực webhook
ZALO_OA_ALLOW_PAID_BOT=false

# Zalo cá nhân
ZALO_PERSONAL_ENABLED=false
ZALO_PERSONAL_MIN_SEND_INTERVAL_MS=3000

# Catalog dezon.vn
CATALOG_PROVIDER=wordpress
CATALOG_BASE_URL=https://dezon.vn
CATALOG_API_USER=
CATALOG_API_APP_PASSWORD=

# Tính năng
FEATURE_AI_ENABLED=false   # Giai đoạn 1: false
UNANSWERED_ALERT_MIN=15
HANDOFF_ESCALATE_AFTER_MIN=15

# Thông báo
LARK_WEBHOOK_URL=
LARK_WEBHOOK_SECRET=
VAPID_PUBLIC_KEY=  VAPID_PRIVATE_KEY=

# Giám sát
SENTRY_DSN=
```

---

## 11. Bảo mật, quyền riêng tư, chất lượng

- **Secret và token kênh** luôn được mã hóa khi lưu; không bao giờ trả về client; không ghi ra log.
- **Log:** không ghi nội dung tin nhắn ở mức `info`; payload đầy đủ chỉ ở `debug` khi bật cờ.
- **Dữ liệu cá nhân:** có chức năng xuất và xóa dữ liệu một khách theo yêu cầu (xóa contact và mọi tin, media, memory). Lưu bằng chứng đồng ý của nhân viên khi kết nối Zalo cá nhân. Đối chiếu quy định bảo vệ dữ liệu cá nhân hiện hành của Việt Nam trước khi chạy thật (việc của chủ sản phẩm).
- **Gửi dữ liệu cho LLM:** chỉ gửi phần cần thiết; không gửi credentials hay thông tin nội bộ ngoài kho kiến thức.
- **Phòng prompt injection:** tin khách được bọc trong thẻ phân tách rõ ràng; system prompt nhắc AI không làm theo chỉ dẫn nằm trong tin khách; tool chỉ đọc (không có tool ghi dữ liệu nhạy cảm).
- **Test:** unit cho ChannelPolicy, Debouncer, pre-filter, chuẩn hóa webhook (dùng payload mẫu lưu trong `__fixtures__`); integration với Testcontainers; E2E Playwright cho kịch bản chị Lan (mock connector).

---

## 12. Câu hỏi cần chủ sản phẩm xác nhận (AI agent: hỏi trước khi làm giai đoạn liên quan)

1. **Catalog dezon.vn** (Giai đoạn 2): "mẫu thiết kế" lưu dạng post thường kèm taxonomy `dz_*`, hay WooCommerce product? Giá có công khai trên web không, hay phải lấy từ bảng giá riêng (Google Sheet)? "Tồn kho" với dịch vụ thiết kế nghĩa là gì: còn nhận đơn, thời gian chờ, hay số lượng?
2. **Giờ làm việc** của đội sale và ai là nhóm trực nhận thông báo ngoài giờ?
3. Có bao nhiêu Fanpage, OA, tài khoản Zalo cá nhân ở thời điểm đầu? (để ước lượng tài nguyên)
4. Có cần trả lời **bình luận** trên bài Fanpage không (ngoài phạm vi bản này)?
5. Có cần đồng bộ khách hoặc đơn sang CRM nào không?
6. Fanpage có chạy quảng cáo Click-to-Messenger không (ảnh hưởng cửa sổ 7 ngày)?

---

## 13. Ngoài phạm vi (không làm trong bản này)

Bình luận Facebook/Instagram, Instagram DM, WhatsApp, TikTok; gửi tin hàng loạt và ZNS/template marketing; gọi thoại; nhóm Zalo; app mobile native.
