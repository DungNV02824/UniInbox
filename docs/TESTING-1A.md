# Kiểm thử Giai đoạn 1A (Fanpage Messenger)

Tài liệu này hướng dẫn chạy thử **toàn bộ Giai đoạn 1A trên máy dev mà không cần Facebook App thật**, rồi chuyển sang thử với App thật.

| Công cụ                        | Việc làm                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `scripts/mock-graph.ts`        | Server giả lập Graph API (Page, Send API, User Profile, `subscribed_apps`, Facebook Login), cổng 4900   |
| `scripts/e2e-1a.ts`            | Bộ kiểm thử nghiệm thu tự động (REST + Socket.IO + webhook đã ký + Postgres), in PASS/FAIL từng mục |
| `scripts/simulate-messenger.ts` | Gửi tay một webhook Messenger đã ký (text, ảnh, echo, delivery, read)                                       |

Cả ba chạy bằng `tsx` của worker và không thêm dependency nào. Các ví dụ dùng Git Bash. Lệnh PowerShell nằm ở mục 2.

> **Không ghi giá trị Meta giả vào `.env`.** Truyền chúng qua biến môi trường khi khởi động tiến trình. Biến môi trường thật luôn được ưu tiên hơn `.env`, vì `process.loadEnvFile` không ghi đè biến đã có.

---

## 1. Chuẩn bị

```bash
docker compose up -d          # Postgres 5433, Redis 6379, SeaweedFS S3 8333, Mailpit
pnpm db:migrate
pnpm db:seed                  # admin + agent (cần SEED_AGENT_EMAIL / SEED_AGENT_PASSWORD trong .env)
npx turbo run build --filter=@dezon/api... --filter=@dezon/worker...
```

Runner mặc định dùng hai tài khoản sau. Có thể đổi bằng `E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD` và `E2E_AGENT_EMAIL/E2E_AGENT_PASSWORD`.

- admin: `admin@dezon.vn` / `Dezon@2026`
- agent: `sale@dezon.vn` / `Sale@2026`

## 2. Chạy mock Graph + api + worker

Mở 3 terminal ở thư mục gốc repo.

**Terminal 1: mock Graph**

```bash
pnpm --filter @dezon/worker exec tsx ../../scripts/mock-graph.ts --port 4900
# Tuỳ chọn: tự gửi webhook message_echoes về API sau mỗi lần gửi thành công (giống Meta thật)
pnpm --filter @dezon/worker exec tsx ../../scripts/mock-graph.ts --port 4900 \
  --echo-webhooks http://localhost:4000 dev-app-secret dev-app-id
```

**Terminal 2 (api) và Terminal 3 (worker)**, Git Bash:

```bash
export META_GRAPH_BASE_URL=http://localhost:4900 META_LOGIN_DIALOG_BASE_URL=http://localhost:4900 \
       META_APP_ID=dev-app-id META_APP_SECRET=dev-app-secret META_VERIFY_TOKEN=dev-verify-token
node apps/api/dist/main.js        # terminal 2
node apps/worker/dist/main.js     # terminal 3 (cùng các biến trên)
```

PowerShell:

```powershell
$env:META_GRAPH_BASE_URL='http://localhost:4900'; $env:META_LOGIN_DIALOG_BASE_URL='http://localhost:4900'
$env:META_APP_ID='dev-app-id'
$env:META_APP_SECRET='dev-app-secret'; $env:META_VERIFY_TOKEN='dev-verify-token'
node apps/api/dist/main.js
```

Có thể thay `node .../dist/main.js` bằng `pnpm --filter @dezon/api dev` và `pnpm --filter @dezon/worker dev` để tự nạp lại khi sửa code.

> `pnpm dev` (turbo) cũng dùng được cho bài thử này: `turbo.json` cho task `dev` đi qua các biến `META_*` (`passThroughEnv`). Các task khác của turbo vẫn ở chế độ env strict, nên đừng truyền `META_*` qua `pnpm build`/`pnpm test`.

Web (tuỳ chọn, để xem giao diện): `pnpm --filter @dezon/web dev`, rồi mở http://localhost:3100.

### Mock Graph giả lập những gì

Mock bám đúng đường dẫn, method, header và body mà `packages/core/src/connectors/messenger/*.ts` gọi. Mọi request Graph đều có version `/v26.0/...`. Nếu version khác `--graph-version`, mock vẫn trả lời nhưng log cảnh báo.

| Endpoint                                                                        | Hành vi                                                                                                                       |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /v26.0/me?fields=id,name,category`                                         | Page token → `{id,name,category}`. User token → lỗi 100 "nonexisting field (category) on node type (User)", giống Graph thật |
| `POST`/`GET`/`DELETE /v26.0/{page}/subscribed_apps`                             | `{success:true}` / danh sách field đã đăng ký. Token của Page khác → lỗi 200                                                 |
| `GET /v26.0/{psid}?fields=first_name,last_name,name,profile_pic`                | Tên tiếng Việt cố định theo PSID, `profile_pic` = `http://localhost:4900/avatar/<psid>.png`                                    |
| `GET /avatar/*.png`                                                             | Ảnh PNG 96×96 tự dựng                                                                                                         |
| `POST /v26.0/{page}/messages`                                                   | JSON (text) hoặc multipart (`filedata`) → `{recipient_id, message_id:"m_mock_<n>"}`. Kiểm `messaging_type`, độ dài < 2000 ký tự |
| `GET /files/<mid>`                                                              | Tải lại tệp đã gửi bằng multipart                                                                                             |
| `GET /v26.0/dialog/oauth` (cả `/dialog/oauth`)                                  | Chuyển 302 ngay về `redirect_uri?code=MOCK_CODE_<n>&state=...`. Thêm `&mock_error=access_denied` để giả lập người dùng bấm Huỷ |
| `GET /v26.0/oauth/access_token`                                                 | Đổi `code` hoặc `fb_exchange_token` → `USER_TOKEN_LL`. Kiểm `client_id`, `client_secret` và `redirect_uri` khớp với lúc mở dialog |
| `GET /v26.0/me/accounts`                                                        | Hai Page kèm `access_token`, `tasks`, `picture`. Có kiểm `appsecret_proof` nếu request gửi kèm                                 |
| `GET /v26.0/me/permissions`, `GET /v26.0/debug_token`                           | Danh sách quyền đã cấp / thông tin token                                                                                      |
| `GET /v26.0/{page}/conversations`, `GET /v26.0/{t_...}/messages`                | Conversations API cho đồng bộ: mỗi Page có 3 hội thoại mẫu (`PSID_SYNC_<3 số cuối page>_1..3`: ảnh, chia sẻ link, nhãn dán), mới nhất trước, phân trang `cursors.after`. Tin gửi qua Send API cũng hiện trong thread |
| `POST /__inbox/message {"psid","text","pageId"?,"fromPage"?,"mid"?}`            | Thêm tin vào thread mà **không** gửi webhook (giả lập webhook bị lỡ). `mid` tuỳ chọn: dùng cùng mid với một webhook để thử chống trùng |
| `GET /__calls?path=&method=` · `POST /__reset` · `GET /__health`                | Nhật ký các request đã nhận (token đã ẩn), dùng để kiểm thử · xoá trạng thái · kiểm tra sống                                |

Token mặc định:

| Token                                                      | Ý nghĩa                                             |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `PAGE_TOKEN_A_DEZON_DESIGN_MOCK` (alias `PAGE_TOKEN_A`)    | Page `100000000000001` "Dezon Design (test)"        |
| `PAGE_TOKEN_B_DEZON_SHOP_MOCK` (alias `PAGE_TOKEN_B`)      | Page `100000000000002` "Dezon Shop (test)"          |
| `USER_TOKEN`, `USER_TOKEN_LL`, `USER_TOKEN_DEZON_ADMIN_MOCK` | Token người dùng (không phải Page)                 |
| `EXPIRED`, `EXPIRED_PAGE_TOKEN_DEZON_MOCK`                 | Lỗi 190/463                                         |

Khi kết nối Fanpage qua API hoặc web, dùng **token dài**. Schema `connectMessengerPageSchema` yêu cầu `pageAccessToken` tối thiểu 20 ký tự, nên alias ngắn như `PAGE_TOKEN_A` sẽ bị từ chối với 400. Alias chỉ tiện khi gọi curl thẳng vào mock.

PSID đặc biệt (khách có id này nhắn tới, rồi nhân viên trả lời):

| PSID             | Kết quả khi gửi / lấy hồ sơ                                       |
| ---------------- | ------------------------------------------------------------------ |
| `PSID_OUTSIDE`   | Send API lỗi `10/2018278` (ngoài cửa sổ) → tin `failed`            |
| `PSID_RATE`      | Lỗi `613` lần đầu, các lần sau thành công → worker thử lại → `sent` |
| `PSID_TOKEN`     | Lỗi `190/460` → kênh cần kết nối lại                               |
| `PSID_NOPROFILE` | Hồ sơ rỗng `{id}`                                                  |
| `PSID_PHONE`     | Hồ sơ lỗi `2018218`                                                |

Muốn thêm Page hoặc token khác: tạo file JSON có các khoá `appId`, `appSecret`, `user`, `pages`, `expiredTokens`, rồi chạy `--config <file>`. Xem kiểu `MockConfig` trong script.

Ví dụ curl:

```bash
curl -s "localhost:4900/v26.0/me?fields=id,name,category" -H "Authorization: Bearer PAGE_TOKEN_A"
curl -s "localhost:4900/__calls?path=/messages&method=POST"
curl -s -X POST localhost:4900/__reset
```

## 3. Bộ nghiệm thu tự động

```bash
pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-1a.ts
```

Runner tự gọi `POST /__reset` của mock. Có thể chạy lại nhiều lần: mỗi lần dùng PSID và mid mới, còn kênh được upsert. Mã thoát khác 0 nếu có mục FAIL hoặc SKIP.

| Mục   | Kiểm tra                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| a     | Đăng nhập admin và agent                                                                                                                     |
| b     | `POST /channels/messenger` với token Page A/B, đặt màu khác nhau; `GET /channels` thấy cả 2 `connected`; mock nhận `POST subscribed_apps`   |
| c     | Webhook text tới Page A từ PSID mới → socket admin **và** agent nhận `message.created` < 3s; tên/màu kênh đúng; tên khách = tên trong mock; có avatar |
| d     | Như c cho Page B; nhãn kênh của 2 hội thoại khác nhau                                                                                       |
| e     | Gửi cùng một webhook (cùng `mid`) 2 lần → chỉ 1 tin và 1 sự kiện                                                                             |
| f     | Tin ảnh (URL trên mock) → attachment có URL ký của S3 (không phải URL gốc), tải về được 200 `image/*`                                        |
| g     | Trả lời từ hộp thư → `message.updated` `sent` < 5s; mock thấy Send API `/v26.0/{page A}/messages`, đúng recipient, `messaging_type=RESPONSE` |
| h1/h2 | Echo Business Suite (`app_id 263902037430900`) → tin `agent`, `senderLabel "Meta Business Suite"`, không trùng. Echo của chính app (mid ở g) → không tạo tin mới |
| k     | Webhook delivery rồi read → `message.updated` `delivered` rồi `seen`                                                                         |
| i     | Đặt `last_customer_message_at` lùi 25 giờ thẳng trong Postgres → `POST messages` trả 422 kèm lý do; `sendWindow.allowed=false`                |
| j     | 5 webhook, mỗi cái trả 200 < 1000ms; worker xử lý xong                                                                                       |
| l     | Agent bị 403 khi kết nối kênh; agent thấy hội thoại chưa phân công; admin tự nhận → agent nhận `conversation.updated` và không còn thấy hội thoại |
| s1    | Sau khi kết nối, job đồng bộ lịch sử nhập 3 hội thoại mẫu mỗi Page: đúng tên khách (từ `participants`), đủ số tin, `unreadCount = 0`; `GET /channels` có `sync.lastBackfillAt`, `backfillRunning=false`, không lỗi |
| s2    | Tin chỉ có trong Conversations API (`/__inbox/message`) → đồng bộ định kỳ nhập trong 1 tick, phát `message.created`, unread tăng như webhook |
| s3    | Cùng một `mid` vừa qua webhook vừa qua đồng bộ → chỉ 1 tin, 1 sự kiện                                                                        |
| s4    | Tin trả lời ở g (Send API → thread của mock) không bị đồng bộ nhập lại thành bản thứ 2                                                      |
| x1–x5 | Bổ sung: chữ ký sai bị chặn, `hub.challenge`; token người dùng/hết hạn bị 400; lỗi Send API `10/2018278` → `failed`; lỗi `613` → thử lại → `sent`; Facebook Login qua dialog mock |

**Thử "worker tắt thì webhook vẫn trả 200" (mục j):**

1. Tắt worker (Ctrl+C).
2. Chạy runner ở chế độ chỉ gửi webhook. Nó POST 1 webhook, đo thời gian, rồi chờ tối đa 60s (`--wait <giây>` để đổi):

   ```bash
   pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-1a.ts --webhook-only
   ```

3. Bật lại worker trong lúc runner đang chờ. Job nằm trong BullMQ sẽ được xử lý và `j2` báo PASS.

Các mục s1–s4 cần worker chạy với `MESSENGER_SYNC_INTERVAL_SEC=5` (mặc định 60 thì phải tăng `--sync-wait 90`). Cờ của runner: `--api <url>`, `--mock <url>`, `--sync-wait <giây>` (mặc định 30), `--no-sync` (bỏ s1–s4).

**Chạy trên một stack tạm, không đụng stack dev đang chạy:** dùng DB riêng và một **Redis riêng** (container khác cổng). Chỉ đổi số DB Redis (`/5`) là chưa đủ: hàng đợi BullMQ thì tách được, nhưng Pub/Sub của Socket.IO (redis-adapter của API, redis-emitter của worker) không phân theo số DB, nên sự kiện realtime của stack tạm sẽ lọt sang trình duyệt đang mở stack thật (và ngược lại):

```bash
docker run -d --name dezon-e2e-redis -p 6380:6379 redis:7-alpine
docker exec dezon-inbox-postgres-1 psql -U dezon -d postgres -c "CREATE DATABASE sync_check"
export DATABASE_URL=postgres://dezon:dezon@localhost:5433/sync_check REDIS_URL=redis://localhost:6380
pnpm db:migrate && pnpm db:seed
pnpm --filter @dezon/worker exec tsx ../../scripts/mock-graph.ts --port 4900 &
export META_GRAPH_BASE_URL=http://localhost:4900 META_APP_ID=dev-app-id META_APP_SECRET=dev-app-secret   META_VERIFY_TOKEN=dev-verify-token META_LOGIN_DIALOG_BASE_URL=http://localhost:4900   API_PORT=4100 API_URL=http://localhost:4100 MESSENGER_SYNC_INTERVAL_SEC=5
node apps/api/dist/main.js & node apps/worker/dist/main.js &
pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-1a.ts --api http://localhost:4100
# xong: tắt 3 tiến trình, DROP DATABASE sync_check, docker rm -f dezon-e2e-redis
```

Kiểm thử Chatbot AI (Gemini thật, cùng kiểu stack tạm): `scripts/e2e-chatbot.ts` (cách dựng stack và chạy nằm ở đầu file).

Biến môi trường của runner: `E2E_API_URL` (http://localhost:4000), `E2E_MOCK_URL` (http://localhost:4900), `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION` (phải khớp với api/worker), `DATABASE_URL` (mặc định đọc từ `.env`).

> Lưu ý: khi một script `tsx` thoát với mã lỗi, pnpm trên Windows có thể in nhầm `Command "tsx" not found`. Hãy xem dòng kết quả phía trên.

## 4. Gửi webhook bằng tay

```bash
export META_APP_SECRET=dev-app-secret   # phải trùng secret api đang dùng
S="pnpm --filter @dezon/worker exec tsx ../../scripts/simulate-messenger.ts"
$S --page 100000000000001 --psid 7770001 --text "Xin chào shop"
$S --page 100000000000001 --psid 7770001 --image http://localhost:4900/avatar/demo.png
$S --page 100000000000001 --psid 7770001 --echo --text "Trả lời từ Business Suite"
$S --page 100000000000001 --psid 7770001 --read
$S --page 100000000000001 --psid PSID_OUTSIDE --text "Khách ngoài cửa sổ"   # rồi trả lời trên web -> tin failed
```

Trang phải là Fanpage đã kết nối (`channel_accounts.external_id`). Nếu không, tin bị bỏ qua.

## 5. Thử bằng giao diện web với mock

1. Đăng nhập http://localhost:3100 bằng admin. Vào **Quản trị** (`/admin/channels`), bấm **Kết nối → Dán Page Access Token**, dán `PAGE_TOKEN_A_DEZON_DESIGN_MOCK` rồi bấm **Kết nối**.
2. Mở thêm một cửa sổ ẩn danh bằng tài khoản agent.
3. Gửi webhook (mục 4). Cả hai cửa sổ hiện tin ngay, kèm nhãn và màu kênh, tên và avatar khách. Trả lời trên web, sau đó xem `GET /__calls`.
4. **Facebook Login:** nút "Kết nối → Facebook" mở `authorizeUrl` do API dựng. Host dialog lấy từ `META_LOGIN_DIALOG_BASE_URL` (trống => `https://www.facebook.com`). Khi thử với mock, đặt `META_LOGIN_DIALOG_BASE_URL=http://localhost:4900` cho api: mock chuyển ngay về callback của API, rồi API chuyển về `/admin/channels?fbSession=...` để chọn Trang. Mục `x5` của runner làm đúng các bước này (nếu API vẫn trả host facebook.com, runner tự đổi host sang mock). `pictureUrl` của mock là `http://`, nên API bỏ qua (API chỉ nhận `https://`).

---

## 6. Thử với Facebook App thật

### 6.1. Tạo và cấu hình App

1. Vào https://developers.facebook.com/apps, tạo App loại **Business**, rồi gắn Business Portfolio của Dezon.
2. Thêm sản phẩm **Messenger** và **Facebook Login for Business** (hoặc Facebook Login).
3. Lấy **App ID** và **App Secret** (Settings → Basic) rồi ghi vào `.env` thật. **Không commit file này.**
   ```
   META_APP_ID=<app id>
   META_APP_SECRET=<app secret>
   META_VERIFY_TOKEN=<chuỗi ngẫu nhiên tự đặt>
   META_GRAPH_VERSION=v26.0
   META_GRAPH_BASE_URL=https://graph.facebook.com
   META_HUMAN_AGENT_ENABLED=false      # chỉ bật khi App đã được duyệt Human Agent
   META_LOGIN_CONFIG_ID=               # tuỳ chọn, Facebook Login for Business (configuration id)
   ```
4. Thêm người thử vào **App Roles** (Administrators/Developers/Testers). Khi App ở chế độ Development, chỉ những người có vai trò trên App mới nhắn được và mới tạo ra webhook. Fanpage dùng thử phải do một người trong số đó quản lý.

### 6.2. Webhook qua đường hầm HTTPS

Meta chỉ gọi webhook qua **HTTPS có chứng chỉ hợp lệ** (không nhận chứng chỉ tự ký), và endpoint phải trả 200 trong ≤ 5 giây.

```bash
ngrok http 4000
# hoặc
cloudflared tunnel --url http://localhost:4000
```

- Đặt `API_URL=https://<tên-miền-tunnel>` trong `.env`. Callback của Facebook Login được dựng từ `API_URL`, xem mục 6.3.
- Messenger → Settings (hoặc Webhooks, object **Page**):
  - Callback URL: `https://<tên-miền-tunnel>/webhooks/messenger`
  - Verify Token: đúng giá trị `META_VERIFY_TOKEN`
  - Meta gửi `GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` và API trả lại challenge.
- Subscribe các field mà code đăng ký cho từng Page (`MESSENGER_SUBSCRIBED_FIELDS`): `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `messaging_referrals`, `messaging_postbacks`, `standby`, `messaging_handovers`.
- Đăng ký theo từng Page (`POST /{page-id}/subscribed_apps`) do API tự làm khi kết nối Fanpage.
- Nếu webhook lỗi liên tục **1 giờ**, Meta gỡ đăng ký của Page. Khi đó phải kết nối hoặc đăng ký lại.

### 6.3. Facebook Login

- Facebook Login (for Business) → Settings → **Valid OAuth Redirect URIs**: `<API_URL>/channels/messenger/oauth/callback`, ví dụ `https://<tên-miền-tunnel>/channels/messenger/oauth/callback`. URI này phải trùng từng ký tự với URI API gửi lên. Bật "Use Strict Mode for redirect URIs".
- `APP_URL` phải là địa chỉ web mà trình duyệt mở được, vì sau callback API chuyển về `<APP_URL>/admin/channels`.
- Quyền tối thiểu (scope) là `pages_show_list`, `pages_manage_metadata`, `pages_messaging`. Có thể thêm `pages_read_engagement` nếu cần đọc dữ liệu Page. Nếu dùng `META_LOGIN_CONFIG_ID`, các quyền này khai báo trong configuration, không gửi kèm `scope`.
- Tài khoản đăng nhập phải có task **MESSAGING** cùng một trong các task **MODERATE**, **MANAGE** hoặc **CREATE_CONTENT** trên Page. Trang không đủ quyền hiện "không đủ quyền".
- Cách khác là dán **Page Access Token** dài hạn: lấy user token qua Graph API Explorer, đổi sang token dài hạn bằng `fb_exchange_token`, rồi lấy Page token từ `GET /me/accounts`. Page token lấy theo cách này không hết hạn.

### 6.4. Danh sách kiểm tra khi thử thật

- [ ] `GET /webhooks/messenger` được Meta xác minh thành công.
- [ ] Kết nối Fanpage (Facebook Login hoặc dán token). Kênh `connected`. `GET /{page}/subscribed_apps` (Graph Explorer) có app kèm đủ field.
- [ ] Một tài khoản tester nhắn Page → tin hiện realtime, có tên và avatar. Nếu thiếu tên, xem quyền _Business Asset User Profile Access_ bên dưới.
- [ ] Gửi ảnh, sticker và tệp → lưu S3, xem được. Ảnh/video/audio mở ngay trong trình duyệt; tệp khác (PDF, Word...) được lưu với `Content-Disposition: attachment` nên bấm vào là **tải xuống**, không mở trong tab (chủ ý, chống nội dung độc như HTML/SVG).
- [ ] Trả lời từ hộp thư → khách nhận được, trạng thái `sent` → `delivered` → `seen`.
- [ ] Trả lời từ Meta Business Suite hoặc Messenger của Page → tin hiện với nhãn "Meta Business Suite", không trùng.
- [ ] Tin do chính app gửi quay lại bằng echo → không tạo tin trùng.
- [ ] Khách cũ hơn 24 giờ → ô soạn bị khoá, API trả 422.
- [ ] Đổi mật khẩu Facebook hoặc gỡ quyền → lỗi 190 → kênh báo cần kết nối lại.
- [ ] Ghi lại các điểm còn mở trong `docs/research/messenger-platform.md` (Open items): `app_id` thật của echo từ Business Suite web, app mobile và Messenger app; subcode ngoài cửa sổ trên v26.0 là `2018278` hay `2534022`; thời hạn của URL CDN tệp đính kèm.

### 6.5. App Review và đưa vào chạy thật

Theo `docs/research/messenger-platform.md` §6, §9:

- Muốn nhận webhook và nhắn tin với **khách không có vai trò trên App**, phải có **Advanced Access** cho `pages_messaging` (và các quyền phụ thuộc `pages_manage_metadata`, `pages_show_list`). Việc này cần **App Review** và App phải ở chế độ **Live**. Trước đó, Send API trả lỗi `200/2018028`.
- Feature **Business Asset User Profile Access** (Advanced) cho phép lấy tên và avatar khách. Không có feature này, hồ sơ trả về rỗng và hệ thống hiện "Facebook user".
- **Human Agent** (tuỳ chọn) cho phép nhân viên trả lời tới 7 ngày sau tin cuối của khách. Phải xin riêng trong App Review (Permissions & Features → Human Agent), và Meta yêu cầu **Business Verification**. Chỉ dùng cho tin do người gõ, không dùng cho bot. Chỉ bật `META_HUMAN_AGENT_ENABLED=true` sau khi được duyệt.
- Từ 27/04/2026, các tag `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` bị trả lỗi 100. Hệ thống không dùng các tag này.
- Hồ sơ App Review nên có: video quay màn hình luồng kết nối Fanpage → khách nhắn → nhân viên trả lời trong hộp thư; mô tả rằng nhân viên là người thật trả lời khách đã chủ động nhắn; chính sách quyền riêng tư; hướng dẫn và tài khoản để reviewer đăng nhập thử.
- Trước khi Live: hoàn tất Business Verification, đặt Privacy Policy URL và Data Deletion URL, kiểm tra Graph version còn hạn (v26.0, chuẩn bị lên v27.0).

## 7. Đồng bộ hội thoại (Conversations API)

Webhook chỉ gửi **tin mới**, và khi Meta App ở chế độ **Phát triển** chỉ gửi cho tin của người có vai trò trong app. Để "gom tất cả tin nhắn về", worker đọc thêm `GET /{page}/conversations?platform=messenger` và `GET /{thread}/messages` bằng Page token (chỉ GET). Tin đi chung luồng tin đến với webhook nên **không bị trùng** (cùng `mid`).

| Chế độ          | Khi nào chạy                                                                                                   | Cách xử lý tin                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Đồng bộ lịch sử | Sau khi kết nối / kết nối lại Page; admin bấm **Đồng bộ lịch sử** (Kênh → 7/30/90/180 ngày); tick tự chạy cho kênh chưa từng đồng bộ lịch sử | Tin cũ hơn lần đồng bộ trước là lịch sử: không tăng chưa đọc, không mở lại hội thoại. Tin sau lần đồng bộ trước (vd. lúc token hết hạn) là tin bị lỡ: như webhook. Hội thoại mới đã được trả lời vào **Đã xong** |
| Đồng bộ định kỳ | Mỗi `MESSENGER_SYNC_INTERVAL_SEC` giây (mặc định 60, `0` = tắt)                                                 | Như webhook: tăng chưa đọc, mở lại hội thoại đã xong, hiện realtime. Tin của khách không có vai trò trong app có thể trễ tối đa một chu kỳ                                      |

Biến môi trường: `MESSENGER_HISTORY_DAYS` (30, số ngày lịch sử), `MESSENGER_SYNC_INTERVAL_SEC` (60, `0` = tắt).

**Giới hạn ở chế độ Phát triển (Development) của Meta App:**

- **Đọc được mọi hội thoại** của Page (kể cả khách không có vai trò), có tên thật của khách. Đã kiểm với Page thật "Demo app".
- **Chỉ trả lời được người có vai trò trong app** (Administrators/Developers/Testers). Gửi cho khách khác bị Meta từ chối; tin hiện đỏ kèm gợi ý "Meta App còn ở chế độ Phát triển". Muốn trả lời mọi khách: App Review cho `pages_messaging` (Advanced Access) rồi chuyển sang **Chính thức (Live)**, xem §6.5.
- Avatar khách mới từ đồng bộ chưa được lấy (cần _Business Asset User Profile Access_, nợ kỹ thuật).

**Trang Kênh** hiện "Đồng bộ lần cuối", lỗi đồng bộ, số hội thoại/tin của lần đồng bộ lịch sử gần nhất (tooltip), cảnh báo khi chạm giới hạn an toàn (500 hội thoại, 200 tin mỗi hội thoại mỗi lần chạy) hoặc khi đồng bộ định kỳ đang **tạm dừng** (Facebook giới hạn tần suất: 15 phút; thiếu quyền đọc: 30 phút; đồng bộ lịch sử lỗi hẳn: 15 phút).

**Kiểm tra nhanh trên DB dev** (không trùng tin, số tin mỗi hội thoại):

```bash
docker exec dezon-inbox-postgres-1 psql -U dezon -d dezon_inbox -c "
select c.display_name, count(m.id) as tin, conv.unread_count, conv.status
from conversations conv join contacts c on c.id = conv.contact_id
join channel_accounts ch on ch.id = conv.channel_account_id
left join messages m on m.conversation_id = conv.id
where ch.external_id = '<page-id>' group by 1,3,4;
select external_message_id, count(*) from messages group by 1 having count(*) > 1;"
```
