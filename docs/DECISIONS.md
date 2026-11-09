# Nhật ký quyết định (DECISIONS)

Ghi lại các quyết định **lệch khỏi đặc tả** (`dezon-omnichannel-ai-spec.md`) hoặc các lựa chọn kỹ thuật cần giải thích. Mỗi mục: ngày, quyết định, lý do, ảnh hưởng. Mục mới thêm vào cuối.

## Giai đoạn 0 — Nền móng

### 2026-11-04 — Dùng SeaweedFS thay MinIO cho S3 ở môi trường dev

- **Đặc tả:** MinIO (dev), Cloudflare R2 hoặc S3 (prod).
- **Quyết định:** dev dùng **SeaweedFS** (`chrislusf/seaweedfs`, có S3 gateway, giấy phép Apache-2.0) ở cổng 8333; bucket `dezon-inbox` được service `s3-init` tạo sẵn.
- **Lý do:** MinIO đã ngừng phát hành image công khai trên Docker Hub/quay.io nên không còn kéo được image ổn định.
- **Ảnh hưởng:** code chỉ nói chuyện qua API S3 (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`), nên prod vẫn dùng R2/S3 như đặc tả, không đổi gì.

### 2026-11-04 — Cổng host riêng cho dev

- **Quyết định:** Postgres **5433**, S3 **8333**, web **3100**, api **4000**; Redis 6379, Mailpit 1025/8025 giữ mặc định.
- **Lý do:** trên máy dev, cổng 3000, 5432 và 9000 đã bị phần mềm khác chiếm.
- **Ảnh hưởng:** tất cả đổi được qua biến môi trường (`POSTGRES_HOST_PORT`, `S3_HOST_PORT`, `REDIS_HOST_PORT`, `MAILPIT_*_HOST_PORT`, `WEB_PORT`, `API_PORT`, cùng các URL tương ứng). Bên trong container vẫn là cổng chuẩn.

### 2026-11-04 — Cố định phiên bản chính (major) của công cụ và thư viện

- **TypeScript 5.9:** bản 7.x là trình biên dịch native mới; chưa kiểm chứng việc sinh decorator metadata mà NestJS cần.
- **NestJS 11:** bản 12 còn rất mới, hệ sinh thái (adapter, module phụ) chưa theo kịp.
- **ESLint 9, Vitest 3, ioredis 5, pino 9:** bản ổn định đã được hệ sinh thái hỗ trợ rộng rãi.
- **Next.js 15.5:** đúng theo đặc tả (Next 15, App Router), dù Next 16 đã có.
- **Ảnh hưởng:** nâng major sau khi có thời gian kiểm thử riêng; ghi lại ở đây khi nâng.

### 2026-11-04 — `@node-rs/argon2` thay cho `argon2` (node-argon2)

- **Đặc tả:** băm mật khẩu bằng argon2.
- **Quyết định:** dùng `@node-rs/argon2` (vẫn là argon2id).
- **Lý do:** có binary dựng sẵn cho mọi nền tảng, không cần node-gyp/trình biên dịch C++ trên Windows.

### 2026-11-04 — Đọc `.env` bằng `process.loadEnvFile` có sẵn của Node

- **Quyết định:** các helper `loadRootEnv()` / `loadEnv()` trong `@dezon/shared/server` tìm file `.env` ở gốc repo và nạp bằng `process.loadEnvFile` (Node ≥ 20.12), sau đó validate bằng Zod.
- **Lý do:** không cần thêm thư viện `dotenv`; một cách nạp env thống nhất cho api, worker và script db.

### 2026-11-04 — Các package biên dịch ra CommonJS (module `NodeNext`)

- **Quyết định:** `tsconfig.base.json` dùng `module`/`moduleResolution` = `NodeNext`, package không khai báo `"type": "module"` nên output là CommonJS.
- **Lý do:** NestJS (decorator, DI, CLI) chạy ổn định nhất với CommonJS; tránh rắc rối ESM/CJS khi chia sẻ code giữa api, worker và các package.

## Quyết định từ các module

### 2026-11-04 — DB: `default_ai_mode` và `conversations.ai_mode` mặc định `'off'` cho mọi kênh

- **Đặc tả (mục 5):** `channel_accounts.default_ai_mode` của `zalo_personal` mặc định `'suggest'`.
- **Quyết định:** mặc định cột là `'off'` cho mọi kênh, kể cả `zalo_personal`.
- **Lý do:** mục 9 yêu cầu mọi hội thoại `ai_mode = 'off'` trong Giai đoạn 0–1; Postgres không đặt được mặc định cột theo giá trị của cột `type`. Giai đoạn 2/4 sẽ đổi bằng migration (như đặc tả mô tả ở Giai đoạn 2) hoặc khi tạo tài khoản kênh.

### 2026-11-04 — DB: `handoffs.created_by` tách thành `created_by` + `created_by_user_id`

- **Đặc tả:** `created_by` ('ai' | user_id).
- **Quyết định:** `created_by text` ('ai' | 'user', có CHECK) và `created_by_user_id uuid?` (FK tới `users`, `ON DELETE SET NULL`); CHECK bảo đảm `'ai'` thì không có user.
- **Lý do:** giữ khóa ngoại thật và không nhầm "AI tạo" với "user đã bị xóa".

### 2026-11-04 — DB: thêm `messages.channel_account_id` và FK ghép tới conversation

- **Đặc tả:** `external_message_id` unique theo channel_account.
- **Quyết định:** thêm cột `messages.channel_account_id` để có unique index thật `(channel_account_id, external_message_id)` (dùng được `ON CONFLICT DO NOTHING`). Migration `0002` thêm unique `conversations(id, channel_account_id)` và FK ghép `messages(conversation_id, channel_account_id) → conversations(id, channel_account_id)` `ON DELETE CASCADE`.
- **Lý do:** FK ghép bảo đảm tin luôn cùng tài khoản kênh với hội thoại; nếu không, một tin lưu sai `channel_account_id` sẽ lọt qua kiểm tra chống trùng webhook.

### 2026-11-04 — DB: thêm ràng buộc unique ngoài đặc tả

- `conversations.contact_identity_id` unique: mỗi identity × channel_account chỉ có một luồng chat (đúng mô hình mục 5), để upsert hội thoại an toàn khi webhook đến song song.
- `catalog_items.external_id` unique: khóa upsert khi đồng bộ catalog từ dezon.vn.

### 2026-11-04 — Migration ngược viết tay trong `packages/db/drizzle/down/`

- **Quyết định:** drizzle-kit không sinh migration ngược; mỗi migration có file `down/<tag>.sql` cùng tên, chạy bằng `rollbackMigrations()` (chỉ dev/test, có thể xóa dữ liệu). File down tự xóa dòng nhật ký của drizzle theo `when` trong `meta/_journal.json` (đang ghi cứng, xem nợ kỹ thuật).

### 2026-11-04 — Auth: refresh token không trạng thái (stateless JWT)

- **Quyết định:** access token (15 phút) và refresh token (30 ngày) đều là JWT HS256, hai secret khác nhau và claim `typ` khác nhau; refresh token nằm trong cookie `dz_refresh` (HttpOnly, `path=/auth`) và được xoay vòng mỗi lần refresh. Mỗi lần refresh/request đều đọc lại user từ DB nên user bị khóa (`is_active = false`) mất quyền ngay.
- **Lý do:** đủ cho Giai đoạn 0, không cần bảng lưu token.
- **Ảnh hưởng:** chưa thu hồi được một refresh token cụ thể trước khi hết hạn (xem nợ kỹ thuật).
- **Bổ sung sau review:** `/auth/refresh` chỉ xóa cookie khi token không hợp lệ (401); lỗi DB tạm thời trả 5xx và giữ cookie. Web chỉ đăng xuất khi refresh trả 401/403.

### 2026-11-04 — API: CORS dùng origin của `APP_URL`

- **Quyết định:** CORS chỉ cho phép đúng một origin là `new URL(APP_URL).origin` (bỏ dấu `/` cuối hoặc path), kèm `credentials: true`.

### 2026-11-04 — Env: TTL của JWT được kiểm tra bằng chính `durationToSeconds`

- **Quyết định:** `JWT_ACCESS_TTL`/`JWT_REFRESH_TTL` phải đúng dạng `15m`, `30d`... và lớn hơn 0, không vượt số nguyên an toàn; sai thì dừng ngay ở bước validate env với thông báo "Biến môi trường không hợp lệ".

### 2026-11-04 — Worker: heartbeat log ở mức info

- **Quyết định:** heartbeat của worker log ở mức info làm tín hiệu còn sống (mỗi phút một dòng, không chứa dữ liệu nhạy cảm).
- **Lý do:** với `LOG_LEVEL=info` mặc định, log dev không cho thấy worker có xử lý job.

### 2026-11-04 — Web: `tsconfig.json` không kế thừa `tsconfig.base.json`

- **Quyết định:** web dùng `module: esnext`, `moduleResolution: bundler`, `jsx: preserve` và plugin `next` theo chuẩn Next.js, vẫn bật `strict` và `noUncheckedIndexedAccess`. Lint của web dùng cấu hình riêng có thêm `eslint-config-next`.
- **Lý do:** base dùng `NodeNext` cho các package CommonJS, không hợp với bundler của Next.

### 2026-11-04 — Web: chống open redirect cho `?next=`

- **Quyết định:** `safeNextPath` chỉ nhận đường dẫn nội bộ: bắt đầu bằng `/`, không `//`, không có ký tự điều khiển hay `\`, và sau khi phân giải bằng `new URL` vẫn cùng origin; trang `/login` bị loại.

### 2026-11-04 — Turbo: build của web phụ thuộc `.env` ở gốc

- **Quyết định:** `apps/web/turbo.json` thêm `$TURBO_ROOT$/.env` vào inputs của `build`, vì `next.config.ts` đọc `NEXT_PUBLIC_API_URL` từ file đó và nhúng vào bundle; đổi `.env` thì cache build của web bị vô hiệu.

## Giai đoạn 1A — Hộp thư hợp nhất + Fanpage Facebook

Ngày ghi: **2026-11-05**. Mỗi dòng: quyết định — lý do. Dữ kiện Meta đã kiểm chứng nằm ở [`research/messenger-platform.md`](./research/messenger-platform.md).

### 2026-11-05 — Kiến trúc và quyền xem

- **Package mới `packages/core` (`@dezon/core`)** chứa connector, policy, đọc/ghi hộp thư, kênh, media, pipeline tin đến/gửi tin. Đặc tả mục 4 đặt connector trong `apps/api` — chuyển ra để worker chạy được cùng một code.
- **Quyền xem:** admin xem tất cả; agent xem hội thoại giao cho mình **và hội thoại chưa phân công** (đặc tả 1.3 chỉ nói "được phân công") — nếu không, hội thoại mới không ai thấy. Phòng socket: `role:admin`, `user:<id>`, `pool:unassigned`.
- **`contacts.avatar_url` lưu storage key S3**, không phải URL; DTO luôn trả URL ký — URL ký có hạn nên không lưu được. Tiền tố: `avatars/` (avatar), `media/` (tin đến), `uploads/` (nhân viên tải lên).
- **`messages.raw = { outbound: { tag? } }`** cho tin nhân viên gửi; worker đọc `tag` (`HUMAN_AGENT`) — không cần thêm cột.
- **Job id outbound `send-<id>`** — BullMQ không cho dấu `:` trong job id.

### 2026-11-05 — Chính sách cửa sổ gửi (6.5)

- Messenger 24 giờ; mốc so sánh tính **bao gồm** biên; khách chưa từng nhắn => chặn — Meta chỉ cho trả lời trong cửa sổ.
- Hội thoại đến từ quảng cáo: mở tới `max(tin cuối + 24h, tin đầu của khách + 7 ngày)` — Meta ghi "may last up to 7 days".
- `HUMAN_AGENT` (24h–7 ngày) chỉ cho agent và chỉ khi `META_HUMAN_AGENT_ENABLED=true` — cần App Review riêng.
- Zalo OA 48h / 7 ngày tính phí; Zalo cá nhân luôn gửi được — cài sẵn cho 1B/1C, chưa dùng.

### 2026-11-05 — Connector Messenger

- **Graph v26.0**; token gửi qua header `Authorization: Bearer` thay vì query `access_token` — tránh lộ token trong URL/log (cần xác nhận trên App thật).
- **Field đăng ký:** `messages, message_echoes, message_deliveries, message_reads, messaging_referrals, messaging_postbacks, standby, messaging_handovers`; sự kiện `standby` parse như `messaging` — không mất tin khi app khác giữ quyền hội thoại.
- **Phân loại echo theo `app_id`:** của mình = `META_APP_ID` hoặc metadata `dezon-inbox` => không lưu lại; Page Inbox/Business Suite (`263902037430900`, `1217981644879628`, bản gõ sai `26390203743090`) và app khác => lưu là tin `agent`, nhãn "Meta Business Suite" — đúng nghiệm thu 1A mục 3, không trùng.
- Tệp đính kèm không hỗ trợ => ghi chú văn bản (vd. `[Liên kết] ...`); referral/handover/reaction/xoá tin đứng riêng bị bỏ qua — ngoài phạm vi 1A.
- **Bảng mã lỗi** theo research: `190`/`102` => token hỏng => kênh `expired`; `10/2018278|2534022` ngoài cửa sổ; `10/2018300` hội thoại do app khác giữ; `551/1545041` khách không nhận được; giới hạn tần suất => lỗi tạm thời (thử lại).
- **Tin gửi tối đa 1999 ký tự/phần** (Meta: "less than 2000"); tách ưu tiên xuống dòng/khoảng trắng, không cắt đôi cặp surrogate; phần thứ i có `sent_at = now + i ms` — giữ đúng thứ tự hiển thị.
- **Hồ sơ khách:** lấy khi identity mới hoặc còn tên tạm, tối đa 1 lần/60s; tên tạm "Khách Messenger …1234"; không ghi đè tên nhân viên đã sửa — tránh gọi Graph thừa và mất chỉnh sửa tay.
- **Trạng thái:** delivery chuyển `sent → delivered` theo `mids` **hoặc** watermark; read chuyển `sent/delivered → seen` theo watermark — Meta không phải lúc nào cũng gửi `mids`.

### 2026-11-05 — Pipeline, media, worker

- **Chống trùng:** SELECT tin đã có trước khi tải media, rồi `INSERT ... ON CONFLICT DO NOTHING`; bên thua xoá file S3 vừa tải — tránh tải thừa và rác S3 khi webhook đến song song.
- **Tải media lỗi:** tin vẫn được lưu; attachment giữ `storage_key = ''` + `original_url` (DTO `url = null`) — không mất tin vì CDN lỗi.
- **Ảnh:** resize ≤1600px (sharp, xoay theo EXIF); gif/svg/sticker giữ nguyên; định dạng lạ => jpeg; HEIC không đọc được => giữ bản gốc — ảnh nhẹ mà không hỏng ảnh động.
- **Worker:** inbound 5 lần thử (exp 2s), outbound 3 lần (exp 5s), lần cuối lỗi => `markOutboundFailed`; media tin đến tối đa 25 MB (tách khỏi `MEDIA_MAX_UPLOAD_MB`) — kích thước tin đến không do mình kiểm soát.

### 2026-11-05 — API

- Lỗi nghiệp vụ => 404/403/422/400; thiếu cấu hình S3/Meta => 503 — client phân biệt lỗi người dùng với lỗi cấu hình.
- Giới hạn body 5 MB chỉ cho `/webhooks/*`; webhook trả 500 khi Redis chết — để Meta gửi lại thay vì mất tin.
- Phát realtime trước khi đẩy job outbound — giao diện thấy tin ngay.
- Upload: whitelist mime + kiểm magic bytes — không tin `Content-Type` của client.
- `createApp(config, overrides)` cho test — thay Graph/S3 giả mà không mock module.
- Bọc lỗi publish của redis-adapter — nếu không, lỗi Redis làm sập process.
- Kết nối sub của redis-adapter tắt ready check — lệnh INFO chen vào lúc đã ở chế độ subscribe bị Redis từ chối.

### 2026-11-05 — Web

- Một layout chung cho `/inbox` và `/inbox/[id]` — giữ danh sách và socket khi chuyển hội thoại.
- Socket `auth` là callback lấy token mới nhất; refresh token không ép reconnect — tránh mất sự kiện.
- Gửi lạc quan với `clientId`, lỗi thì có "Gửi lại"; ô soạn khoá (kèm lý do) khi hết cửa sổ hoặc kênh mất kết nối.
- Lọc "Chưa đọc" giữ hội thoại vừa đọc tới khi tải lại — danh sách không nhảy dưới tay người dùng.
- Avatar chữ cái bỏ qua từ trong ngoặc như "(test)" — tránh hiện "D(".

### 2026-11-05 — Kết nối Fanpage bằng Facebook Login

Dán Page Access Token vẫn giữ làm phương án dự phòng.

- **Interface riêng `MessengerLoginApi`** (`createMessengerLoginApi`), không thêm method vào `MessengerGraphApi` — tránh làm hỏng Graph giả trong test khác; override test `AppOverrides.messengerLogin`.
- **`config_id` hay `scope`:** có `META_LOGIN_CONFIG_ID` (chỉ chữ số) => gửi `config_id`, `response_type=code`, `override_default_response_type=true`, không `scope` (configuration phải là loại User access token); không có => `scope=pages_show_list,pages_manage_metadata,pages_messaging` — Meta khuyên không dùng `scope` với Login for Business; `business_management` không phải quyền phụ thuộc nên không xin mặc định.
- **Token:** gửi `appsecret_proof` (HMAC hex) cho `/me`, `/me/accounts`; token qua header Authorization; phân trang bằng `cursors.after` thay vì gọi `paging.next` — URL `next` chứa access_token.
- **Ảnh Page:** xin `picture{url}`, Meta từ chối (lỗi 10, 100, 200–299) thì gọi lại không có field này — không để ảnh làm hỏng cả luồng.
- **`canMessage`** = task `MESSAGING` + một trong `MODERATE`/`MANAGE`/`CREATE_CONTENT`; Meta không trả `tasks` thì vẫn cho thử — theo tài liệu Send API và `subscribed_apps`.
- **State và phiên:** `state` 32 byte ngẫu nhiên, Redis 10 phút, dùng một lần (GETDEL); phiên đăng nhập id 24 byte, Redis 15 phút, Page token mã hoá bằng CryptoService với AAD gắn phiên + Page; admin khác hoặc phiên hết hạn => 404; connect xoá phiên trước (dùng một lần) — token không bao giờ nằm trong URL/log.
- **Connect từng Page:** Page `!canMessage` hoặc không có trong phiên bị từ chối mà không gọi Meta; `connectMessengerPage` thêm tham số thứ 4 tuỳ chọn `{connectedBy, pictureUrl, expectedPageId}` — `expectedPageId` chặn token của Page khác.
- **`channel_accounts.settings`** gộp thêm `{connectedBy, pictureUrl}`, giữ các khoá khác; dán token ghi `connectedBy={provider:'token'}` — để web nhóm kênh theo cách kết nối.
- **DTO bổ sung:** `FacebookLoginPageDto.cannotMessageReason` (tooltip), `FACEBOOK_LOGIN_ERROR_CODES` = `denied | state | exchange | not_configured | unknown`.
- **Callback không bao giờ trả lỗi ra trình duyệt:** luôn 302 + `cache-control: no-store`, thiếu cấu hình Meta => `fbError=not_configured`; `start` trả 503 khi thiếu cấu hình.
- **`redactUrl` trong `common/logger.ts`** (file của Giai đoạn 0) cho request log và `AllExceptionsFilter` — không thì URL callback ghi `code`/`state` ra log.
- **Biến mới `META_LOGIN_DIALOG_BASE_URL`** (trống => `https://www.facebook.com`) — để trỏ dialog sang mock khi kiểm thử.
- **`turbo.json`: task `dev` cho qua `META_*`** (`passThroughEnv`) — trước đó `pnpm dev` âm thầm bỏ biến Meta đặt ở shell.
- **Web:** nút "Kết nối" mở menu "Facebook" (chuyển trang bằng `window.location.assign`) / "Dán Page Access Token"; đọc `?fbSession`/`?fbError` một lần rồi xoá bằng `history.replaceState` (không cần Suspense/`useSearchParams`); kênh nhóm theo tài khoản Facebook, kênh dán token xếp cuối nhóm "Kết nối bằng token", trong nhóm chia theo nền tảng; "Kết nối lại" chạy lại Facebook Login hoặc mở hộp thoại token (dùng lại `POST /channels/messenger`, không cần endpoint riêng) tuỳ cách kết nối ban đầu; hướng dẫn cài đặt thu gọn được; menu là popover tự viết — repo chưa có thư viện dropdown.

### 2026-11-05 — Bổ sung sau review (final gate)

Mỗi dòng: quyết định — lý do.

**Gửi tin (worker, core)**

- **Gửi tuần tự theo hội thoại:** trước khi gửi, worker kiểm còn tin `queued` sớm hơn (theo `sent_at, id`, tạo trong 5 phút trước) trong cùng hội thoại thì `moveToDelayed(+1s)` + `DelayedError` (không tốn lượt thử). Không dùng BullMQ Pro groups hay khoá Redis — đủ cho 1A, không thêm hạ tầng; tin `queued` cũ hơn 5 phút không chặn để một dòng mồ côi không làm kẹt cả hội thoại.
- **Một lần gửi = một batch** (`raw.outbound.batchId`); một phần lỗi hẳn thì các phần sau của batch bị đánh `failed` (`MSG_BATCH_ABORTED`) — khách không nhận nửa câu trả lời lộn xộn.
- **Lỗi ngoài cửa sổ từ Meta trên hội thoại `ads`** => đặt `window_source = organic` (phát `conversation.updated`, ô soạn khoá); tin của nhân viên chưa có tag được gửi lại **một lần** với `HUMAN_AGENT` nếu policy cho phép — cửa sổ 7 ngày của quảng cáo không được Meta bảo đảm.
- **Metadata Send API = `dezon-inbox:<messageId>`**; echo của chính app mang metadata này đánh dấu tin `sent` (nếu còn `queued`) — chống gửi trùng khi Meta đã nhận nhưng request bị timeout/5xx. Vẫn nhận dạng metadata cũ `dezon-inbox`.
- **Delivery receipt đến trước khi ghi `sent`:** chạy lại job inbound sau khi xử lý xong các sự kiện khác (`ReceiptNotReadyError`); read receipt không thử lại — read luôn đến sau delivery và watermark tự bù ở lần sau. Không cho delivery khớp tin `queued` vì worker sẽ bỏ qua không gửi.
- **Chống gửi trùng theo `clientId`:** cột mới `messages.client_id varchar(100)` (migration `0003_message_client_id`, có migration ngược) lưu trên **mọi phần** của một lần gửi, index thường một phần `(conversation_id, client_id) WHERE client_id IS NOT NULL`. `sendAgentMessage` kiểm sau khoá `FOR UPDATE` dòng hội thoại (nên hai request đồng thời vẫn an toàn) và trước kiểm cửa sổ/kênh: trùng => trả tin cũ, `duplicate = true`; API không phát `message.created` lại, chỉ đẩy lại job cho tin còn `queued` (jobId cố định nên không gửi trùng). Không dùng unique index vì một lần gửi tách nhiều phần cùng clientId; khoá dòng đã đủ. Lợi ích phụ: "Gửi lại" sau khi API trả 503 vì đẩy job lỗi giờ đẩy lại đúng tin đã lưu thay vì tạo bản thứ hai.

**Media, DB, API**

- **Content-Type khi lưu S3 theo allowlist:** image/video/audio (trừ svg) và các loại tài liệu đã biết; còn lại (svg, html...) => `application/octet-stream`; svg khai là ảnh => `type: 'file'`. Mọi tệp không phải ảnh/video/audio lưu kèm `Content-Disposition: attachment` (tên tệp mã hoá an toàn) — URL ký mở trên origin S3, không được để trình duyệt render HTML/SVG của khách. Hệ quả: PDF tải xuống thay vì mở trong tab.
- **`createDb` luôn gắn listener `'error'` cho pool** (tuỳ chọn `onError`; worker và API truyền logger) — lỗi kết nối rảnh không làm sập process.
- **Log truy cập API ẩn giá trị query** `code`, `state`, `access_token`, `fb_exchange_token`, `client_secret`, `hub.verify_token` (cả dạng `hub%2Everify_token`). Tham số mới có thể chứa secret phải thêm vào `SECRET_QUERY_PARAMS` trong `apps/api/src/common/logger.ts`.

**Web**

- **Làm mới URL ký:** dữ liệu chứa URL ký (tin, danh sách, chi tiết hội thoại) refetch mỗi 20 phút; tin còn refetch khi quay lại tab nếu đã cũ; ảnh/video lỗi tải => invalidate trang tin một lần cho mỗi tệp. Giả định `MEDIA_SIGNED_URL_TTL_SEC` > 20 phút (schema cho tối thiểu 60s — TTL ngắn chỉ được cứu bởi onError).
- **Refetch tin được gộp với cache** (`structuralSharing: mergeFetchedMessages`) thay vì thay thế — không mất tin đến qua socket trong lúc fetch; giả định 1A không xoá tin.
- **Trạng thái tin chỉ tiến trên client** (`received`/`queued` < `sent`/`failed` < `delivered` < `seen`) — bản cũ từ POST/refetch không ghi đè bản mới từ socket.
- **Socket resync (invalidate hộp thư) ở mọi lần connect**, kể cả lần đầu; sự kiện đến khi tin đang tải lần đầu => huỷ và tải lại.
- **Phím Enter:** màn cảm ứng (`pointer: coarse`) Enter xuống dòng, chỉ nút Gửi mới gửi; desktop Enter gửi, Shift+Enter xuống dòng.
- **Khi nào tính là đã đọc:** chỉ khi trang hiển thị **và** danh sách tin đang ở cuối; cuộn lên thì tin mới hiện nút "N tin mới ↓" và vẫn chưa đọc.
- **Bản nháp** giữ trong bộ nhớ theo người dùng + hội thoại, xoá khi đăng xuất — máy dùng chung.
- **Lựa chọn phân công cho agent** chỉ gồm những gì core cho phép (nhận về mình, bỏ nhận của mình); admin thấy mọi nhân viên.
- **Lọc theo nhân viên:** admin có thêm ô chọn "Người phụ trách" (từ `/users/directory`, gửi `assignee=<uuid>`); dòng hội thoại hiện tên người phụ trách ("Bạn" nếu là mình) cạnh nhãn kênh. Agent không có ô này — chỉ thấy hội thoại của mình + chưa phân công.
- **Từ ngữ:** trạng thái "Đã xong"; nút đặt trạng thái "Đánh dấu xong". Nhãn kênh nằm dòng riêng trong danh sách hội thoại.

### 2026-11-05 — Đồng bộ hội thoại Messenger qua Conversations API

Yêu cầu của chủ dự án: "gom tất cả tin nhắn về". Webhook không gửi lịch sử, Meta App ở chế độ Phát triển chỉ gửi webhook cho người có vai trò trong app, và Meta có thể bỏ webhook khi sự cố. Vì vậy hệ thống đọc thêm `GET /{page}/conversations?platform=messenger` + `GET /{thread}/messages` (chỉ GET, bằng Page token). Đã kiểm với Page thật: API trả mọi hội thoại, kể cả khách không có vai trò, kèm tên thật. Dữ kiện ở `research/messenger-platform.md` §13.

**Hai chế độ, một hàng đợi `channel-sync`**

- **backfill** (lịch sử `MESSENGER_HISTORY_DAYS`, mặc định 30 ngày): tự đẩy sau khi kết nối Page (cả dán token lẫn Facebook Login) và khi admin bấm "Đồng bộ lịch sử" (`POST /channels/:id/sync {days?: 1..365}` → **202** kèm `ChannelAccountDto`; 404 không có kênh; 422 không phải Messenger hoặc chưa kết nối; 409 đang có job backfill chờ/chạy/chờ thử lại). Body bỏ trống => `days = MESSENGER_HISTORY_DAYS`.
- **incremental** (mỗi `MESSENGER_SYNC_INTERVAL_SEC`, mặc định 60, `0` = tắt): job scheduler `channel-sync:tick` đẩy một job incremental cho mỗi kênh Messenger `connected` không bị tạm dừng. Đọc hội thoại cập nhật từ `lastSyncedAt - 2 phút`. **Kênh chưa từng đồng bộ lịch sử** (`sync.lastBackfillAt` trống: kênh kết nối trước khi có tính năng, hoặc backfill lỗi hẳn) thì tick đẩy **backfill `MESSENGER_HISTORY_DAYS`** thay vì incremental (và bật `backfillRunning`). Nhánh "chưa từng đồng bộ thì đọc 24 giờ" của incremental chỉ còn là dự phòng.
- **jobId cố định** `sync-<mode>-<channelId>` + `removeOnComplete/removeOnFail: true`. jobId chỉ chặn trùng khi job còn chờ/chạy, job đã xong không chặn lần bấm sau. Gặp job đã xong mà còn lưu thì xoá rồi đẩy lại.
- **Hai chế độ không chạy chồng trên một kênh** (concurrency của hàng đợi là 2): tick bỏ qua kênh có job incremental hoặc backfill chưa xong; job incremental bắt đầu chạy mà thấy backfill của kênh đang chờ/chạy thì **bỏ lượt** (`{skipped: 'backfill'}`); job backfill thấy incremental của kênh đang `active` thì **chờ** (poll 1s, tối đa 2 phút, quá thì vẫn chạy và log warn). Incremental không bao giờ chờ nên không thể khoá chéo. API `enqueueBackfill` không cần kiểm incremental.
- **Tuỳ chọn job:** backfill `attempts: 3`, backoff mũ 30s; incremental `attempts: 1` (tick sau tự thử lại); tick không thử lại; concurrency 2.

**Nhập tin**

- **Đi chung luồng tin đến với webhook** (`processInboundMessage`, tham số `source`). id tin của Conversations API trùng `mid` của webhook và `message_id` của Send API, nên chống trùng theo `(channel_account_id, external_message_id)` sẵn có phủ luôn đồng bộ. PSID trong `participants` trùng `contact_identities.external_user_id`, không cần ánh xạ.
- **backfill chia cửa sổ tại một mốc**: tin cũ hơn mốc là **lịch sử** — cập nhật mốc cửa sổ gửi (`last_customer_message_at`) nhưng **không tăng unread, không mở lại hội thoại đã xong**, không phát `message.created`; tin từ mốc trở đi là **tin bị lỡ** và xử lý như webhook (unread++, mở lại, `message.created`). Mốc = `sync.lastSyncedAt` trước đó − 2 phút (vd. token hết hạn qua đêm rồi kết nối lại: tin khách nhắn trong đêm hiện là chưa đọc), hoặc lúc chạy − 2 phút nếu kênh chưa từng đồng bộ; mốc không lùi quá 7 ngày (quá 7 ngày Messenger không cho trả lời nữa, tránh hàng nghìn sự kiện realtime khi kênh ngắt lâu). Cuối mỗi hội thoại có tin mới backfill phát **một `conversation.updated`**. **incremental** xử lý y như webhook.
- **Hội thoại MỚI do backfill tạo** được đặt `resolved` ("Đã xong") sau khi nhập, **trừ khi** còn việc thật: có tin chưa đọc (tin bị lỡ), đã phân công, hoặc tin cuối là của khách và còn trong cửa sổ 24 giờ. Hội thoại đã có trước lần đồng bộ không bao giờ bị đổi trạng thái. Lý do: backfill 30–180 ngày không được làm ngập hàng "Đang mở" bằng hội thoại đã trả lời từ Business Suite. Không thêm trạng thái "imported" (không đổi enum/migration).
- **Nhận ra tin của chính hệ thống:** API không trả `app_id`/metadata và `tags` không đáng tin. Outbound và echo của chính app ghi mọi `mid` thành công vào `messages.raw.sentExternalIds`. Tin của Page bị bỏ qua nếu id nằm trong danh sách đó, hoặc nếu cùng hội thoại có tin gửi đi còn `queued` cùng nội dung trong ±10 phút (khoảng trước khi worker kịp lưu kết quả Send API). Phần tệp (không có chữ) chỉ khớp tin `queued` **có tệp đính kèm** — trước đây khớp mọi tin `queued`, nên ảnh gửi từ Business Suite bị nuốt khi đang có một tin chữ khác chờ gửi. Tin khác của Page được nhập thành `agent`, không có user, nhãn "Meta Business Suite".
- **Tên khách:** tên trong `participants` được dùng làm gợi ý hồ sơ. Nó thay tên tạm "Khách Messenger …" nhưng không ghi đè tên nhân viên đã sửa. Khách mới từ đồng bộ (`raw.source = 'sync'`) đã có tên thì **không gọi `GET /{psid}`** lấy hồ sơ (backfill N khách = N lượt gọi thừa, ở chế độ Phát triển luôn lỗi + WARN). Đổi lại các khách này chưa có avatar (nợ kỹ thuật).
- **Mốc cửa sổ quảng cáo** (`firstCustomerMessageAt`, dùng cho `window_source = 'ads'`) bỏ qua tin khách nhập từ đồng bộ (`raw.source = 'sync'`); chỉ khi hội thoại không có tin webhook nào mới dùng tin đầu tiên bất kỳ. Lịch sử cũ kéo về không được kéo lùi mốc (cửa sổ ngắn sai, bot bị chặn trong cửa sổ quảng cáo thật). Một hàm dùng chung (`pipeline/window-anchor.ts`) cho read model, lệnh gửi và outbound.
- **Chia sẻ liên kết:** tin có chữ thì giữ chữ. Không có chữ thì ghi "[Liên kết] tên — link thật" (bỏ lớp chuyển hướng `l.facebook.com`).
- **Giới hạn mỗi lần chạy:** 500 hội thoại, 200 tin mới nhất mỗi hội thoại, xử lý tin cũ trước. Graph bỏ qua `since` nên code tự lọc phía mình và dừng phân trang ở mục cũ đầu tiên. Phân trang bằng `cursors.after`. Chạm giới hạn thì `SyncResult.truncated = true`, log warn, và backfill lưu `backfillConversations`, `backfillMessagesStored`, `backfillTruncated` vào `settings.sync` (trang Kênh hiện số đếm và cảnh báo "đạt giới hạn an toàn").

**Lỗi và trạng thái**

- **Lỗi đọc** dùng lại `PermanentSendError`/`TransientSendError` (`mapReadError`). Lỗi token (190/102, subcode OAuth) đánh dấu kênh `expired` như outbound. Lỗi 10 hoặc 200–299 là "không có quyền đọc hội thoại". Rate limit và 5xx là lỗi tạm. Lỗi token hoặc lỗi tạm dừng cả lần chạy. Lỗi khác ở một hội thoại chỉ bỏ hội thoại đó và ghi "Không đồng bộ được N hội thoại". Worker chuyển `PermanentSendError` thành `UnrecoverableError` (không thử lại). Kênh không `connected` thì bỏ qua, không gọi Meta.
- **Trạng thái** gộp vào `channel_accounts.settings.sync` bằng SQL (giữ `connectedBy`, `pictureUrl`), DTO trả `ChannelAccountDto.sync`. API ghi `backfillRunning: true` **trước** khi đẩy job: worker có thể chạy xong trước khi `add()` trả về, ghi sau sẽ làm cờ kẹt ở `true`. Đẩy job lỗi (Redis tắt, giới hạn 3s) thì ghi `backfillRunning: false` + `lastError`, việc kết nối Page vẫn thành công. Worker/core ghi `lastSyncedAt`, `lastBackfillAt`, `backfillDays`, `backfillRunning: false`. Backfill thất bại hẳn thì hook failed ghi "Đồng bộ lịch sử thất bại: …". Lỗi lưu bằng tiếng Việt, không chứa token.
- **Tạm dừng thay vì thử lại mỗi phút** (`settings.sync.pausedUntil`, tick bỏ qua kênh đang tạm dừng; lần đồng bộ thành công xoá): Facebook giới hạn tần suất (mã 4, 17, 32, 613, 80001, 80006, HTTP 429) => 15 phút; lỗi không thử lại được mà không do token (thiếu quyền đọc 10/2xx, máy chủ chưa cấu hình) => 30 phút; backfill thất bại hẳn => 15 phút (để backfill tự động của tick không lặp vô hạn). Token hỏng => kênh `expired`, tick tự bỏ qua. Worker không có connector Messenger (thiếu `META_*`) thì tick không đẩy job nào (đã cảnh báo một lần lúc khởi động). Chưa đọc header `X-Business-Use-Case-Usage` (nợ kỹ thuật).
- **Log:** chỉ log số đếm. Lần incremental không có tin mới log ở mức debug, nếu không mỗi phút mỗi Page ghi một dòng info. Lỗi incremental chỉ log **một lần** (core, mức error); processor không ném lại cho BullMQ (incremental `attempts: 1`, tick sau tự chạy) nên không có thêm dòng "Job thất bại" kèm stack. Backfill vẫn ném để BullMQ thử lại.
- **Hợp đồng (mở rộng, không phá vỡ):** `ChannelSyncState` thêm trường tuỳ chọn `backfillConversations`, `backfillMessagesStored`, `backfillTruncated`, `pausedUntil`; `SyncResult.truncated?`. Worker: `ChannelSyncHandlers.listConnectedMessenger` đổi thành `listSyncTargets` (`{id, needsBackfill}`) + `markBackfillQueued`; `TickResult` thêm `backfills`; `runChannelSyncTick(queue, handlers, historyDays)`.

**Web**

- Trang Kênh: dòng trạng thái đồng bộ dưới mỗi kênh Messenger **đang kết nối** (kênh hết hạn chỉ hiện dòng lỗi của kênh, tránh cùng một lỗi token hiện hai lần kèm "Chưa đồng bộ lần nào"), nút "Đồng bộ lịch sử" (hộp thoại chọn 7/30/90/180 ngày) chỉ hiện cho kênh `connected` và bị khoá khi `backfillRunning`. Trang này poll 5s khi có kênh đang backfill, nếu không thì 60s. Lỗi chỉ hiện khi mới hơn lần đồng bộ thành công gần nhất. Tooltip lần đồng bộ lịch sử có số hội thoại / tin mới; cảnh báo màu vàng khi chạm giới hạn hoặc đang tạm dừng.
- Hộp thư: tin gửi thất bại với lỗi thiếu quyền gửi / không tìm thấy người nhận có thêm dòng gợi ý "nếu Meta App còn ở chế độ Phát triển chỉ trả lời được người có vai trò trong app…". Lý do: sau khi đồng bộ, khách không có vai trò hiện trong hộp thư nhưng chưa trả lời được cho tới khi App Review + chế độ Chính thức; mã lỗi Send API thật cho trường hợp này chưa kiểm được (không được POST tới Meta khi kiểm thử).
- `conversation.updated` và phần hội thoại của `message.created` được gom trong 200ms (sự kiện lẻ áp dụng ngay), nên một lần backfill phát hàng trăm sự kiện chỉ làm danh sách vẽ lại vài lần. Tin trong khung chat đang mở không bị trễ. Hội thoại mới từ backfill được chèn theo thứ tự tin cuối, theo cùng quy tắc với danh sách hiện có.

**Kiểm thử:** mock Graph mỗi Page có 3 hội thoại mẫu (ảnh, chia sẻ link, nhãn dán). Tin gửi qua Send API của mock cũng hiện trong thread. `POST /__inbox/message {psid, text, pageId?, fromPage?, mid?}` thêm tin mà không gửi webhook. `e2e-1a.ts` có thêm các mục s1–s4 và cờ `--api/--mock/--sync-wait/--no-sync`.

### 2026-11-06 — Web: thiết kế lại trang admin Kênh + xóa kênh

- **Bỏ nhóm theo tài khoản Facebook** (tiêu đề nhóm to + "Facebook (1)") — thay bằng một dòng nhỏ "Kết nối bởi …" / "Kết nối bằng Page Access Token" trong thẻ kênh. Lý do: hầu hết mỗi tài khoản chỉ có 1 Trang, tiêu đề nhóm chiếm nhiều chỗ hơn chính kênh; không thêm bộ lọc theo tài khoản (ít kênh, chưa cần). `groupChannels` bị xoá, `PLATFORM_LABELS` giữ (hộp thư dùng).
- **Hai mục:** "Kênh đang kết nối" (connected + expired/error, kênh hết hạn/lỗi lên đầu rồi theo tên) dạng thẻ, lưới 2 cột từ 1024px; "Kênh đã ngắt kết nối (n)" thu gọn mặc định, dòng gọn màu xám, ngắt gần nhất lên trước. Ngày ngắt hiển thị bằng `updatedAt` (không có cột riêng).
- **Thao tác phụ vào menu "⋯"** (popover tự viết `components/admin/action-menu.tsx`, có phím mũi tên/Home/End/Esc): thẻ đang kết nối chỉ để một nút chính ("Đồng bộ lịch sử", hoặc "Kết nối lại" khi hết hạn/lỗi); menu có Sửa / Ngắt kết nối / Xóa kênh (Xóa chỉ khi không `connected`, khớp 409 của API).
- **Xóa kênh:** hộp thoại nêu số hội thoại/tin sẽ xóa (từ `stats` của GET /channels), phải gõ đúng tên kênh (trim, phân biệt hoa thường) mới bật "Xóa vĩnh viễn"; gọi `DELETE /channels/:id {confirmName}`, hiện nguyên thông báo 409/400 của API, xong thì invalidate `channels` + `conversations`. Hàm gọi API nằm ở `lib/channels-admin.ts` (không sửa `lib/inbox-api.ts` để tránh đụng việc song song ở hộp thư).
- Viên trạng thái: "Đang hoạt động" / "Hết hạn" / "Lỗi" (tooltip = lỗi gần nhất, kèm hộp lỗi đỏ trong thẻ để đọc được bằng bàn phím/trình đọc màn hình) / "Đã ngắt kết nối".

### 2026-11-06 — Xóa hẳn kênh đã ngắt kết nối (`DELETE /channels/:id`)

- **Lệch đặc tả/quy tắc cũ:** FK `RESTRICT` tới `channel_accounts` vốn chặn xóa kênh còn dữ liệu (chỉ ngắt bằng `status`). Chủ dự án cần dọn các kênh thử/không dùng nữa, nên thêm thao tác xóa có kiểm soát; FK giữ nguyên `RESTRICT` (không ai xóa kênh "lỡ tay" bằng SQL kéo theo dữ liệu).
- **Điều kiện:** chỉ admin; kênh không ở trạng thái `connected` (409 "Hãy ngắt kết nối kênh trước khi xóa"; `expired`/`error`/`disconnected` xóa được); body `{ confirmName }` phải trùng đúng `displayName` sau khi trim (400 "Tên kênh xác nhận không khớp").
- **Một transaction** (`@dezon/core` `deleteChannel`): khóa dòng kênh `FOR UPDATE` (webhook/đồng bộ ghi dữ liệu mới vào kênh phải chờ, sau đó lỗi FK và lần thử lại không còn thấy kênh) → gom storage key media → xóa tin → xóa khách **chỉ** có mặt ở kênh này (không còn danh tính *và* không còn hội thoại ở kênh khác; CASCADE kéo theo danh tính, hội thoại, `customer_memories`) → xóa hội thoại/danh tính còn lại của kênh → `audit_logs` `channel.delete` `{type, externalId, displayName, counts}` → xóa `channel_accounts`. Xóa khách trước danh tính (khác thứ tự mô tả ban đầu) để chọn khách mồ côi bằng một câu SQL, không phải truyền danh sách id; kết quả như nhau.
- **Tệp S3** (media tin + avatar của khách bị xóa, bỏ avatar là URL http) xóa **sau khi commit**, best-effort: song song 16, lỗi chỉ log; 5 lỗi liên tiếp thì dừng (S3 chết không làm treo request). S3 chưa cấu hình => bỏ qua, log cảnh báo. Tệp sót lại là rác vô hại.
- **Job còn trong hàng đợi:** outbound không thấy tin => bỏ qua (có sẵn); `syncMessengerAccount` không thấy kênh => bỏ qua thay vì ném lỗi (trước đây BullMQ thử lại vô ích).
- **`GET /channels` có `stats {conversations, messages}`** — một truy vấn, LEFT JOIN hai bảng đếm theo nhóm (không N+1), để hộp thoại xóa cho admin thấy sẽ mất bao nhiêu dữ liệu.

### 2026-11-06 — Xóa kênh: bổ sung sau kiểm tra

- **Thứ tự kiểm tra khi xóa:** 404 → 409 (kênh `connected`) → 400 (tên sai). Kênh đang kết nối luôn trả 409 kể cả khi gõ sai tên, vì điều thực sự chặn việc xóa là phải ngắt kết nối trước; tên chỉ được so khi kênh đã có thể xóa. Có test core + e2e cho trường hợp này.
- **So khớp tên xác nhận** (web `normalizeConfirmName` + core `normalizeConfirmName`, cùng quy tắc): Unicode NFC rồi trim; vẫn phân biệt hoa thường và dấu. Lý do: bộ gõ tiếng Việt có thể sinh chữ tổ hợp (NFD) trông y hệt nhưng khác byte. Đặt dấu khác vị trí ("xoá"/"xóa") là chữ khác, không chuẩn hóa; hộp thoại gợi ý bấm vào tên kênh để chọn rồi sao chép.
- **Thẻ kênh trên điện thoại** (< sm): viên trạng thái xuống dòng dưới tên, tên xuống tối đa 2 dòng thay vì bị cắt.
- **Nợ kỹ thuật — `stats` trong `GET /channels`:** mỗi lần gọi đếm toàn bộ `messages`/`conversations` theo kênh (hộp thư của mọi nhân viên cũng gọi endpoint này cho bộ lọc kênh). Hiện dữ liệu nhỏ nên nhanh; `messages` chưa có index theo `channel_account_id`. Khi dữ liệu lớn: chỉ tính khi trang admin yêu cầu (vd `?stats=1`, cần đổi hợp đồng) hoặc thêm index / bộ đếm cộng dồn. Chưa làm lúc này để không đổi hợp đồng và không chạy migration trên môi trường đang chạy.
