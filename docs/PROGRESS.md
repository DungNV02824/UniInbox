# Tiến độ (PROGRESS)

Cập nhật cuối mỗi giai đoạn: đã xong gì, còn gì, nợ kỹ thuật. Các quyết định lệch đặc tả ghi ở [`DECISIONS.md`](./DECISIONS.md).

| Giai đoạn | Nội dung                            | Trạng thái   |
| --------- | ----------------------------------- | ------------ |
| 0         | Nền móng                            | Xong (chờ CI trên GitHub) |
| 1A        | Hộp thư hợp nhất + Fanpage Facebook | Xong với mock Graph (chờ thử App Facebook thật) |
| 1B        | Zalo OA                             | Chưa bắt đầu |
| 1C        | Zalo cá nhân của nhân viên          | Chưa bắt đầu |
| 1D        | Hoàn thiện để chạy thật             | Chưa bắt đầu |
| 2         | AI tự trả lời + chuyển người thật   | Đã làm theo hướng mới: **Chatbot AI (Gemini)**, xem mục dưới |
| 3         | AI đọc ảnh + nhớ khách hàng         | Chưa bắt đầu |
| 4         | AI cho Zalo cá nhân + thống kê      | Chưa bắt đầu |

## Giai đoạn 0 — Nền móng

### Nghiệm thu

- [x] `docker compose up` và `pnpm dev` chạy được cả api, worker, web.
- [x] Đăng nhập bằng admin seed, nhận JWT; tài khoản `agent` bị chặn ở route chỉ dành cho admin.
- [x] Migration chạy sạch trên DB trống; test mã hóa/giải mã đạt.
- [ ] CI xanh — các bước của `.github/workflows/ci.yml` đã chạy đạt trên bản sao sạch (không `.env`); chưa chạy thật trên GitHub Actions vì repo chưa có commit/remote.

### Đã xong

- Monorepo pnpm + Turborepo, TypeScript strict (`NodeNext`, CommonJS), ESLint flat config, Prettier, `.editorconfig`, `.gitattributes` (`eol=lf`).
- `docker-compose.yml` dev: Postgres 16 + pgvector (5433), Redis 7, SeaweedFS S3 (8333, thay MinIO), Mailpit.
- `packages/shared`: enum hợp đồng mục 5, schema Zod dùng chung (auth, config, message), `durationToSeconds`; `@dezon/shared/server`: nạp + validate env (mục 10), `encrypt/decrypt` AES-256-GCM cho `credentials`.
- `packages/db`: Drizzle schema đủ 15 bảng mục 5 (vector 1024 + HNSW), migration `0000` (extension vector), `0001` (schema), `0002` (FK ghép messages → conversations), migration ngược, `db:migrate`, `db:seed` (admin + agent, argon2id, chạy lại an toàn).
- `apps/api`: NestJS 11 + Fastify, config validate bằng Zod, pino (ẩn secret/token), `/health` (DB + Redis), `/config` (cờ `FEATURE_AI_ENABLED`, `ZALO_PERSONAL_ENABLED`), đăng nhập / refresh (cookie httpOnly, xoay vòng) / đăng xuất / `/auth/me`, RBAC (`GET /users` chỉ admin), helmet, CORS, `x-request-id`.
- `apps/worker`: khung BullMQ, hàng đợi `system` với job mẫu `echo` và `heartbeat` lặp mỗi phút, tắt êm.
- `apps/web`: Next 15.5 + React 19 + Tailwind 4, trang đăng nhập, khôi phục phiên im lặng, layout 3 cột rỗng, ẩn phần AI theo cờ, chống open redirect qua `?next=`.
- GitHub Actions: install (frozen lockfile), format:check, lint, typecheck, test, build.
- Test: vitest cho mọi package; test tích hợp dùng Testcontainers (`pgvector/pgvector:pg16`, `redis:7-alpine`), không phụ thuộc `.env`.

### Còn lại

- Chạy CI thật trên GitHub Actions sau commit/push đầu tiên.
- Giai đoạn 1A trở đi theo mục 9.

### Nợ kỹ thuật

- Refresh token không trạng thái: chưa thu hồi được trước khi hết hạn (cần bảng/Redis lưu token hoặc `token_version` trên `users`).
- Chưa giới hạn tần suất (rate limit) cho `/auth/login`.
- File migration ngược ghi cứng `when` của `meta/_journal.json`; nên để `rollbackMigrations()` tự đọc journal.
- Chưa có script `clean`; `dist` cũ có thể còn sót.
- Worker gọi `loadEnv()` nên cần đủ env của cả app (JWT, ENCRYPTION_KEY...); nên có schema env riêng cho worker.
- Bundle JS của web khoảng 222–228 kB do kéo theo zod.
- Turbo cảnh báo "IO error ... link name" khi cache `.next/standalone` (symlink của pnpm quá dài); vô hại nhưng output build của web có thể không được cache đủ.
- CORS chỉ một origin cố định; nếu cho phép nhiều origin cần trả `Vary: Origin`.

## Giai đoạn 1A — Hộp thư hợp nhất + Fanpage Facebook

Cập nhật 2026-11-05. 1A đã chạy với **Facebook App thật ở chế độ Phát triển** và Page thật "Demo app" (kết nối bằng Facebook Login): tin vào qua webhook, trả lời từ hộp thư tới Messenger (`delivered`), đồng bộ hội thoại kéo về cả khách không có vai trò. Phần còn lại phía Meta được kiểm bằng mock Graph (`scripts/mock-graph.ts`) và bộ nghiệm thu `scripts/e2e-1a.ts` (19/19 PASS; chạy lại ở final gate sau đợt sửa lỗi review: 19/19 PASS), cộng kiểm tra bằng trình duyệt (Playwright). Cách chạy lại: [`TESTING-1A.md`](./TESTING-1A.md).

### Nghiệm thu

Ba mục đầu đạt với mock nhưng chỉ đánh dấu xong khi thử với Fanpage thật (xem "Còn lại").

- [ ] Kết nối 2 Fanpage test; tin vào mỗi Page hiện trong ≤ 3 giây, đúng tên, avatar, nhãn và màu từng Page. **Đạt với mock** (mục b/c/d: 166–311 ms tới cả 2 socket, nhãn 2 Page khác nhau; kiểm lại trên trình duyệt).
- [ ] Trả lời từ hộp thư thì khách nhận được trên Messenger. **Đạt với mock** (mục g: `sent` sau 35–86 ms, đúng lệnh Send API; gửi chữ và ảnh từ trình duyệt). Chưa chứng minh tin tới Messenger thật.
- [ ] Trả lời từ Meta Business Suite hiện là tin nhân viên, không trùng. **Đạt với mock** (h1: lưu `agent`, nhãn "Meta Business Suite"; h2: echo của chính app không tạo tin trùng). Cần payload echo thật của Meta.
- [x] Ảnh khách gửi xem được kể cả khi URL gốc của Facebook hết hạn (mục f: ảnh lưu S3, URL ký tải được độc lập với URL gốc).
- [x] Webhook trùng 2 lần chỉ lưu 1 tin (mục e: 1 tin, 1 sự kiện).
- [x] Quá 24 giờ thì nút gửi bị khóa kèm lý do (mục i: 422 + `sendWindow.allowed=false`; ô soạn bị thay bằng "Không thể gửi tin. Đã quá 24 giờ…" trên trình duyệt).
- [x] Webhook trả 200 trong < 1 giây kể cả khi worker tắt; xử lý khi worker bật lại (mục j: 2–4 ms; tắt worker, `--webhook-only` trả 200 trong 4 ms, bật lại sau 10 s thì tin được xử lý sau ~2 s).
- [x] Hai nhân viên mở cùng hội thoại đều thấy tin mới realtime (mục c: cả 2 socket; admin + agent trên trình duyệt thấy tin sau ~1,4 s).

Cổng chất lượng ở gốc repo (final gate, 2026-11-05): `pnpm install --frozen-lockfile` đạt, `pnpm build` 6/6, `pnpm lint` 9/9, `pnpm typecheck` 9/9, `pnpm format:check` đạt, `pnpm test` **453 test đạt ngay lần đầu** (shared 32, web 97, worker 18, db 30, api 84, core 192). 1A thêm một migration: `0003_message_client_id` (có migration ngược).

### Đã xong

- `packages/core` (`@dezon/core`, mới): connector Messenger (kiểm chữ ký, parse `messages`/`message_echoes`/`message_deliveries`/`message_reads`/`standby`, Send API chữ + tệp multipart, hồ sơ khách, bảng mã lỗi), policy cửa sổ gửi (6.5), đọc/ghi hộp thư theo quyền, quản lý kênh, media S3 (resize ảnh, URL ký), pipeline inbound (6.1, bỏ bước AI) và outbound (6.6).
- `apps/worker`: processor `inbound` / `outbound` (thử lại có backoff, đánh dấu `failed` lần cuối), phát realtime qua `@socket.io/redis-emitter`.
- `apps/api`: webhook Messenger (verify + chữ ký, trả 200 ngay, đẩy job); REST hội thoại / tin / khách / kênh / upload media; Socket.IO xác thực JWT với Redis adapter; kết nối Fanpage bằng **Facebook Login** (start → callback → chọn Trang → connect) hoặc dán Page Access Token; ẩn `code`/`state` trong log.
- `apps/web`: hộp thư 3 cột realtime (lọc, phân công, đổi trạng thái, đánh dấu đọc, gửi chữ + ảnh lạc quan có "Gửi lại", nhãn kênh màu, đồng hồ cửa sổ gửi, cột thông tin khách sửa tên/ghi chú/tag), giao diện mobile một cột; trang **Quản trị → Kênh** (kết nối bằng Facebook hoặc token, nhóm theo tài khoản Facebook, đổi tên hiển thị + màu, ngắt, kết nối lại).
- Công cụ kiểm thử không cần App thật: `scripts/mock-graph.ts`, `scripts/e2e-1a.ts`, `scripts/simulate-messenger.ts`; tài liệu [`TESTING-1A.md`](./TESTING-1A.md); dữ kiện Meta đã kiểm chứng ở [`research/messenger-platform.md`](./research/messenger-platform.md).
- Env mới: `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_ENDPOINT`, `MEDIA_MAX_UPLOAD_MB`, `MEDIA_SIGNED_URL_TTL_SEC`, `META_GRAPH_BASE_URL`, `META_LOGIN_CONFIG_ID`, `META_LOGIN_DIALOG_BASE_URL`.

### Còn lại

Thử với Facebook App thật (App loại Business + đường hầm HTTPS, xem `TESTING-1A.md` §6) để chốt nghiệm thu 1–3 và các điểm mở trong `research/messenger-platform.md`:

- Graph nhận token qua header `Authorization: Bearer` (code không gửi `access_token` trên query).
- `app_id` thật của echo từ Business Suite web, app Business Suite mobile và Messenger app (dự kiến `263902037430900`).
- Subcode lỗi ngoài cửa sổ trên v26.0: `2018278` hay `2534022`.
- Gửi tệp multipart (`filedata`), nhất là audio/video; phản hồi khi gửi bằng `attachment_id`; thời hạn URL CDN tệp đính kèm.
- Facebook Login: luồng `config_id` có trả user token dùng được với `/me/accounts` không; Page thuộc business portfolio có cần `business_management` không; định dạng `appsecret_proof` (hex).
- App Review: Advanced Access cho `pages_messaging` (+ `pages_manage_metadata`, `pages_show_list`) để nhắn với khách không có vai trò trên App; feature **Business Asset User Profile Access** để lấy tên/avatar; **Human Agent** (cần Business Verification) trước khi bật `META_HUMAN_AGENT_ENABLED`.
- Dọn dữ liệu thử trong DB dev (2 Page mock đã kết nối, nhiều hội thoại thử) trước khi kết nối Page thật.
- Giai đoạn 1B (Zalo OA) theo mục 9.

### Nợ kỹ thuật

- Messenger: chưa xử lý sự kiện referral đứng riêng (chỉ referral kèm tin); handover/reaction/xoá tin bị bỏ qua.
- Không kiểm định kỳ `subscribed_apps` (Meta tắt webhook sau 1 giờ lỗi liên tục); chưa đọc header `X-Business-Use-Case-Usage` để giảm tốc.
- Send API thường chưa dùng `appsecret_proof` (chỉ luồng Facebook Login có).
- Tin có thể kẹt ở `queued` nếu đẩy job lỗi và nhân viên không bấm "Gửi lại" (chưa có job quét lại); có thể gửi trùng nếu worker chết sau khi Send API thành công nhưng trước khi ghi DB và Meta không trả echo kèm metadata.
- Socket không bị ngắt khi token hết hạn hoặc user bị khoá.
- `pictureUrl` của Page là URL CDN Meta có thể hết hạn, chưa có job làm mới (UI về chữ cái đầu).
- Facebook Login: connect xoá phiên trước nên một lỗi tạm thời buộc đăng nhập lại; chưa ghi audit log cho lần đăng nhập (chỉ cho từng lần connect).
- Web: chưa kiểm kích thước tệp phía client trước khi upload; chưa ảo hoá danh sách tin; chưa có component test (chỉ test hàm thuần).
- Thiếu cấu hình Meta/S3 ném HttpException 5xx nên bị log ở mức error.

### Đồng bộ hội thoại Messenger (Conversations API) — 2026-11-05

Mục tiêu: gom **mọi** tin nhắn của Page về hộp thư, kể cả khách không có vai trò trong Meta App (chế độ Phát triển) và tin bị lỡ webhook. Quyết định chi tiết ở `DECISIONS.md` ("Đồng bộ hội thoại Messenger").

- **Đã xong:** hàng đợi `channel-sync`. backfill N ngày (`MESSENGER_HISTORY_DAYS`, mặc định 30) tự chạy sau khi kết nối Page và khi bấm "Đồng bộ lịch sử" (`POST /channels/:id/sync`). incremental chạy mỗi `MESSENGER_SYNC_INTERVAL_SEC` (60s). Tin đi chung luồng tin đến với webhook nên không trùng. `ChannelAccountDto.sync` hiện trạng thái đồng bộ trên trang Kênh. Danh sách hội thoại gom sự kiện realtime trong 200ms.
- **Kiểm chứng với mock:** `e2e-1a.ts` **23/23 PASS** trên stack tạm (DB `sync_check`, Redis db 5, `MESSENGER_SYNC_INTERVAL_SEC=5`):
  - s1: 6 hội thoại mẫu, đúng tên, unread 0;
  - s2: tin lỡ webhook về sau 2,7s;
  - s3: cùng mid qua webhook + đồng bộ chỉ lưu 1 tin;
  - s4: tin gửi từ hộp thư không bị nhập lại.
- **Kiểm chứng với Page thật "Demo app":** 3 hội thoại. Cao Hung 8 tin, Đúng Văn 10 tin (2 tin `failed` cục bộ), Tuấn Kiệt 2 tin. Tên thật lấy từ `participants`. Backfill 30 ngày chạy lại thì 0 tin mới, 18 tin bỏ qua (không trùng). Tick incremental chạy mỗi 60s, không lỗi.
- **Cổng chất lượng:** `pnpm build` 6/6, `lint` 9/9, `typecheck` 9/9, `format:check` đạt. `pnpm test` có **527 test** đạt: shared 32, web 115, worker 39, db 30, api 94, core 217.

Nợ kỹ thuật của phần đồng bộ:

- Chưa kiểm định dạng ảnh, video, tệp và nhãn dán trên dữ liệu thật.
- Mỗi hội thoại có cập nhật tốn một lần gọi `/messages`.
- Nhận ra tin của chính hệ thống khi còn `queued` dựa vào so khớp nội dung (heuristic). Một tin `failed` cục bộ mà Meta thực ra đã giao sẽ bị nhập thêm một bản.
- Thời gian của Meta chỉ tính tới giây, nên thứ tự tin có thể bằng nhau.
- Khách mới từ đồng bộ không gọi `fetchProfile` (đã có tên) nên **chưa có avatar**; cần job lấy avatar chậm, ưu tiên thấp (khi có _Business Asset User Profile Access_).
- Lỗi đọc dùng lại lớp `*SendError`.
- Tick dùng bộ lọc kênh trong bộ nhớ.
- `backfillRunning` có thể kẹt `true` nếu Redis mất job. Khi đó trang Kênh poll 5s mãi; cần dọn phía server.
- Lỗi của một lần backfill còn được thử lại vẫn tạm tắt cờ `backfillRunning` cho tới lần thử sau.
- Tạm dừng khi bị giới hạn tần suất dùng thời gian cố định (15 phút), chưa đọc `X-Business-Use-Case-Usage` / `X-App-Usage`.
- Cửa sổ quảng cáo vẫn neo vào tin webhook đầu tiên của khách (đã bỏ tin đồng bộ), chưa neo đúng vào tin mang referral ADS; tin organic cũ qua webhook trước khi bấm quảng cáo vẫn làm cửa sổ ngắn lại. Sửa đúng: lưu `conversations.window_started_at` khi referral đến (cần migration).
- Hội thoại mới từ backfill được đặt "Đã xong" khi tin cuối là của Page hoặc khách nhắn quá 24 giờ — khách nhắn 1–7 ngày trước chưa ai trả lời cũng vào "Đã xong" (chỉ trả lời được bằng HUMAN_AGENT).
- Backfill chờ incremental đang chạy bằng poll (tối đa 2 phút, giữ một slot concurrency).
- Mã lỗi Send API thật khi trả lời khách không có vai trò ở chế độ Phát triển chưa kiểm (không được POST tới Meta trong kiểm thử); gợi ý trên UI dựa vào thông điệp "chưa có quyền gửi tin" / "không tìm thấy người nhận".

Sửa sau review đồng bộ (2026-11-05, chi tiết ở `DECISIONS.md`): backfill chia mốc lịch sử / tin bị lỡ (kết nối lại sau khi token hết hạn không còn nuốt tin chưa đọc); hai chế độ không chạy chồng (incremental bỏ lượt, backfill chờ); tick tự backfill kênh chưa từng đồng bộ lịch sử; hội thoại mới chỉ có lịch sử vào "Đã xong"; ảnh từ Business Suite không bị coi là bản sao của tin chữ đang chờ gửi; tạm dừng đồng bộ khi bị giới hạn tần suất / lỗi không thử lại được; lỗi incremental chỉ log một lần; không gọi hồ sơ khách cho mỗi khách đồng bộ; mốc cửa sổ quảng cáo bỏ qua lịch sử đồng bộ; trang Kênh hiện số đếm + cảnh báo chạm giới hạn, không lặp lỗi token; gợi ý chế độ Phát triển dưới tin gửi lỗi; README/.env.example/TESTING-1A §7.

### Bổ sung sau review (final gate)

Đợt review cuối 1A tìm ra và sửa (chi tiết quyết định ở `DECISIONS.md`, mục "Bổ sung sau review"):

- **Core/worker:** các phần của một lần trả lời có thể tới khách sai thứ tự => gửi tuần tự theo hội thoại + huỷ phần còn lại khi một phần lỗi hẳn; worker sập khi kết nối Postgres rảnh bị ngắt => pool luôn có listener `'error'`; delivery receipt đến trước `sent` bị mất => chạy lại job; lỗi ngoài cửa sổ trên hội thoại quảng cáo => về `organic` + thử lại `HUMAN_AGENT` một lần; media lưu theo Content-Type của máy chủ ngoài => allowlist + `Content-Disposition: attachment`; timeout sau khi Meta đã nhận => echo có metadata `dezon-inbox:<id>` xác nhận `sent`, không gửi lại.
- **API:** `hub.verify_token` lộ trong access log => đã ẩn.
- **Web:** URL ký hết hạn trong hội thoại mở lâu => refetch 20 phút + làm mới khi ảnh lỗi; tin realtime mất khi đang refetch => gộp cache; trạng thái tin lùi => chỉ tiến; ghi chú "Huỷ" lại lưu; Enter gửi trên điện thoại; agent thấy lựa chọn phân công bị 403; zoom iOS; nút "Kết nối" kẹt sau Back; nhãn kênh bị cắt; không báo tin mới khi cuộn lên (và tự đánh dấu đọc); nháp còn sau đăng xuất; nút xoá tag quá nhỏ.
- **Final gate (cross-area):** chống gửi trùng theo `clientId` (cột `messages.client_id`, migration `0003`); admin lọc hội thoại theo nhân viên + dòng hội thoại hiện người phụ trách; API dùng `createDb(..., { onError })`.
- **Kiểm chứng:** cổng chất lượng ở trên; `e2e-1a.ts` 19/19 PASS (c 375 ms, d 272 ms, g `sent` sau 47 ms, j 2–3 ms); trình duyệt (bản build): đăng nhập, lọc theo nhân viên, mở hội thoại, gửi tin => `sent` (mock), `client_id` đã lưu, không lỗi console.

Nợ kỹ thuật mới:

- Object đã có trên S3 giữ Content-Type cũ (chỉ ảnh hưởng dữ liệu dev).
- Hai request gửi khác nhau trong cùng hội thoại chạy đua: `sent_at` lấy trước khi khoá dòng nên request thứ hai có thể đi trước.
- Một dòng tin nhiều phần (chữ + tệp, bot sau này): echo đánh dấu `sent` giữa chừng thì phần sau timeout không được thử lại (hiện mỗi dòng đúng một phần).
- Delivery receipt vẫn khớp theo `sent_at` (thời điểm tạo, không phải lúc gửi thật).
- Thử lại delivery receipt đến sớm có thể làm vài job inbound lỗi ồn ào sau 5 lần nếu tin kẹt `queued` lâu.
- Che query trong log là danh sách tên cố định; nên chuyển sang chỉ log path + allowlist tham số.
- URL ký được làm mới bằng polling 20 phút (giả định TTL > 20 phút); nên có endpoint ổn định redirect sang URL ký mới cho từng tệp/avatar.
- Refetch định kỳ danh sách hội thoại có thể ghi đè một `conversation.updated` đến trong lúc fetch (sự kiện sau sửa lại) và làm rơi các dòng "Chưa đọc" đang giữ; danh sách chưa có hàm gộp như tin. Lần tải đầu danh sách không được khởi động lại khi socket kết nối lần đầu.
- Web chưa có jsdom/testing-library: huỷ ghi chú, nút "N tin mới", đánh dấu đọc khi ở cuối, ô lọc nhân viên chỉ được kiểm qua hàm phụ trợ hoặc trình duyệt thủ công.
- Xoá tag chưa có toast hoàn tác; `useDirectory` vẫn được gọi cho agent (ô phân công); mark-as-read lỗi liên tục thì thử lại sau mỗi lần refetch.
- `messages.client_id` không có unique index (chống trùng dựa vào khoá dòng hội thoại): code ghi tin agent khác ngoài `sendAgentMessage` phải tự kiểm.

## Chatbot AI (Gemini) — thay cho Giai đoạn 2 của đặc tả (2026-11-09)

Chủ sản phẩm đổi hướng: không tra catalog/giá dezon.vn, mà **tự viết chatbot** rồi bật bot cho từng hội thoại. LLM là Google Gemini (`GEMINI_MODEL` mặc định `gemini-3.5-flash`). Quyết định chi tiết ở `DECISIONS.md` (các mục "Chatbot AI").

### Đã xong

- **Dữ liệu** (migration `0004_chatbots`): bảng `chatbots`, `app_settings` (giờ làm việc, Lark, công tắc AI tổng); `conversations.chatbot_id`, `channel_accounts.default_chatbot_id`, `ai_runs.chatbot_id`.
- **Luồng chạy (worker):** tin khách (webhook / đồng bộ định kỳ, không tính lịch sử kéo về) vào hội thoại có bot ⇒ gom tin (debounce) ⇒ kiểm điều kiện (AI tổng, bot bật, không chờ người, không tạm dừng, cửa sổ gửi, giới hạn/giờ) ⇒ lọc từ khóa chuyển người (không gọi model) ⇒ Gemini (hướng dẫn + kiến thức + câu mẫu + lịch sử 30 tin + ảnh khách) ⇒ trả lời 1–3 bong bóng (gửi giãn 0,8–1,5 s) hoặc chuyển người thật (tin hệ thống, âm thanh + thông báo trên web, thẻ Lark, nhắc lại sau 15 phút nếu chưa ai nhận). Chống đua khi khách nhắn thêm lúc bot đang nghĩ; nhân viên nhắn ⇒ bot tạm dừng 30 phút. Mỗi lượt ghi `ai_runs` (model, token, thời gian, quyết định).
- **API:** CRUD chatbot + "Chat thử"; bật/tắt bot trên hội thoại, "Tiếp tục AI", "Nhận xử lý", "Đã xong, trả lại cho AI", nhật ký AI; Cài đặt giờ làm việc / Lark / công tắc AI tổng; bot mặc định của kênh.
- **Web:** Quản trị › Chatbot AI (trình soạn bot theo tab + khung Chat thử), Quản trị › Cài đặt, ô "Chatbot mặc định" ở trang Kênh; trong hộp thư: ô chọn bot ở đầu khung chat, dòng "AI tạm dừng — Tiếp tục AI", banner đỏ "Cần người", tin bot nền tím "AI · <tên bot>", bộ lọc "Cần người" / "AI đang lo", mục "Nhật ký AI" (admin).

### Cách dùng (cho chủ sản phẩm)

1. **Tạo bot:** Quản trị › **Chatbot AI** › Thêm chatbot. Tab *Hướng dẫn*: viết giọng văn và quy tắc (ví dụ "xưng em, gọi anh/chị, trả lời ngắn"). Tab *Kiến thức*: dán bảng giá, câu hỏi thường gặp, địa chỉ… — bot chỉ được dùng những gì ghi ở đây, không tự bịa giá. Tab *Câu trả lời mẫu*: vài cặp khách hỏi / bot đáp đúng ý anh/chị. Tab *Chuyển người thật*: từ khóa (giảm giá, khiếu nại, gặp nhân viên…) — khách nhắn trúng là chuyển ngay cho nhân viên, không qua AI. Tab *Nâng cao*: độ trễ gom tin (mặc định 10 giây), giới hạn lượt trả lời mỗi giờ.
2. **Thử trước khi dùng:** gõ như khách ở khung **Chat thử** bên phải; xem bot trả lời hay chuyển người, mất bao lâu. Chat thử không gửi gì cho khách.
3. **Bật cho khách:** trong hộp thư, bấm ô **"🤖 Chatbot"** ở đầu khung chat và chọn bot (chọn "Tắt" để tắt). Nếu khách đang chờ, bot trả lời luôn. Muốn mọi hội thoại MỚI của một Fanpage tự có bot: Quản trị › Kênh › "Chatbot mặc định".
4. **Khi bot chuyển cho người thật:** hộp thư kêu chuông + hiện thông báo, hội thoại có banner đỏ "Cần người" (lý do + tóm tắt) và vào bộ lọc "Cần người"; nhóm Lark nhận thẻ có nút "Mở hội thoại". Bấm **"Nhận xử lý"**, trả lời khách, xong thì bấm **"Đã xong, trả lại cho AI"** để bot lo tiếp. Bấm "Xong" (đóng hội thoại) thì bot vẫn tắt cho tới khi bấm **"Bật lại"**.
5. **Nhân viên tự nhắn** vào hội thoại có bot ⇒ bot tạm dừng 30 phút ("AI tạm dừng đến hh:mm — Tiếp tục AI").
6. **Cài đặt** (Quản trị › Cài đặt): giờ làm việc (bot vẫn trả lời ngoài giờ nhưng biết là ngoài giờ để nói với khách), webhook Lark (+ nút Gửi thử), công tắc **tắt toàn bộ AI** khi cần.

### Kiểm thử

- Unit/integration (vitest, Testcontainers, Gemini giả) ở shared/db/core/api/worker/web; typecheck + lint toàn repo xanh.
- **E2E với Gemini thật + mock Facebook** trên stack cô lập: `scripts/e2e-chatbot.ts` (cách dựng stack ở đầu file; Redis phải là instance riêng). Lần chạy 2026-11-09 trên code sau review: **22/22 PASS** (9 lượt Gemini, Lark qua server bắt thẻ): khách mới ⇒ bot trả lời sau ~8 s (Gemini 2–5 s, ~1.700 token vào), 2 bong bóng gửi giãn ~1,2 s; 3 tin cách 1 s ⇒ đúng 1 lượt AI; "giảm giá" ⇒ chuyển người lý do giảm giá, không gọi model, có thẻ Lark; "trả lại cho AI" không nhắn gì ⇒ câu hỏi khác vẫn được trả lời (không chuyển lại); "Xong" ⇒ bot tắt, "Bật lại" ⇒ auto; nhân viên nhắn ⇒ tạm dừng 30 phút, "Tiếp tục AI" ⇒ trả lời; tắt AI tổng ⇒ im lặng; ngoài giờ vẫn trả lời; giới hạn/giờ; chống đua (khách nhắn thêm lúc Gemini đang chạy ⇒ hủy + gom); bật bot cho khách đang chờ ⇒ tự trả lời; Chat thử trả tiếng Việt. Trước đó đã gửi 1 thẻ Lark thật vào nhóm demo (tên khách "[TEST] …").

### Nợ kỹ thuật / rủi ro

- Lựa chọn trả lời hay chuyển người của Gemini không cố định: câu hỏi ngoài kiến thức thường bị chuyển người (`out_of_scope`) — muốn bot tự trả lời thì bổ sung kiến thức.
- Chưa kiểm e2e: thẻ nhắc lại sau 15 phút, ảnh khách gửi cho Gemini, bot có "tin giữ chỗ" khi chuyển người.
- Thẻ Lark escape ký tự đặc biệt của tên/tóm tắt bằng HTML entity (`&#91;`…): nên xem một thẻ thật để chắc hiển thị đúng.
