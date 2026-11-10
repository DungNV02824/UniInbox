# Triển khai production (VPS dùng chung Caddy)

Một VPS Ubuntu 24.04, một domain `alo.vuathau.com.vn` (Cloudflare proxy). Cổng 80/443 do Caddy dùng chung
(`qspro-web-1`, Caddyfile ở `/opt/qspro/infra/deploy/Caddyfile`, mạng `qspro_default`) nắm giữ và tự cấp
chứng chỉ. Project này **không publish cổng host nào**; Caddy chung gọi container theo tên:

| Đường dẫn công khai                      | Tới                           | Ghi chú                                         |
| ---------------------------------------- | ----------------------------- | ----------------------------------------------- |
| `https://alo.vuathau.com.vn/api/*`        | `dezon-inbox-api:4000`        | Bỏ tiền tố `/api`; gồm cả Socket.IO (websocket) |
| `https://alo.vuathau.com.vn/dezon-inbox/*` | `dezon-inbox-s3:8333`         | URL ký media, giữ nguyên path + Host, chỉ GET/HEAD |
| còn lại                                  | `dezon-inbox-web:3100`        | Next.js                                         |

Thành phần (`docker-compose.prod.yml`, project `dezon-prod`): `dezon-inbox-db` (Postgres 16 + pgvector),
`dezon-inbox-redis`, `dezon-inbox-s3` (SeaweedFS), `dezon-inbox-s3-init` + `dezon-inbox-migrate` (chạy một lần),
`dezon-inbox-api`, `dezon-inbox-worker`, `dezon-inbox-web`. db/redis/worker chỉ ở mạng riêng `backend`.

## 1. Chuẩn bị lần đầu

1. Tạo thư mục, ví dụ `/opt/dezon-inbox`, chép vào: `docker-compose.prod.yml` và `.env.production`
   (copy từ `.env.production.example`, điền giá trị thật, `chmod 600 .env.production`).
   - `ENCRYPTION_KEY` **phải giống hệt** khóa đang dùng nếu mang dữ liệu cũ lên (token Page đã mã hóa).
   - `POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`: chỉ dùng chữ/số (`openssl rand -hex 24`).
   - Mật khẩu/khóa S3 chỉ được đọc khi container khởi tạo lần đầu (Postgres) / mỗi lần khởi động (S3).
     Đổi `POSTGRES_PASSWORD` sau khi đã có dữ liệu thì phải đổi cả trong DB (`ALTER USER`).
2. Thêm site block: dán nội dung `deploy/caddy-site.alo.vuathau.com.vn.caddy` vào Caddyfile chung rồi
   reload (sau khi các container dezon đã chạy, nếu không Caddy báo 502 cho tới lúc đó):
   ```bash
   docker exec qspro-web-1 caddy reload --config /etc/caddy/Caddyfile
   ```
   (Đường dẫn config trong container tùy cách mount — xem `docker inspect qspro-web-1`.)
3. Cloudflare: bản ghi `A alo` → IP VPS, bật proxy (mây cam), SSL/TLS mode **Full (strict)** (Caddy có chứng
   chỉ Let's Encrypt thật). Nếu Caddy chưa xin được chứng chỉ qua Cloudflare, tạm tắt proxy (mây xám) để cấp
   rồi bật lại.

## 2. Build image (trên máy dev) và chuyển lên VPS

```bash
# Trên máy dev, tại thư mục repo (cần .env.production có NEXT_PUBLIC_API_URL đúng)
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker save dezon-inbox-api:latest dezon-inbox-worker:latest dezon-inbox-web:latest | gzip > dezon-inbox-images.tar.gz
scp dezon-inbox-images.tar.gz user@vps:/opt/dezon-inbox/

# Trên VPS
cd /opt/dezon-inbox
gunzip -c dezon-inbox-images.tar.gz | docker load
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

`NEXT_PUBLIC_API_URL` được nhúng vào image web lúc build — đổi domain thì phải build lại image web.
Thứ tự khởi động tự động: db/redis/s3 khỏe → tạo bucket + migration → api, worker → web.

Tạo tài khoản admin đầu tiên (đọc `SEED_ADMIN_*` trong `.env.production`; chạy lại an toàn):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate \
  node node_modules/@dezon/db/dist/scripts/seed.js
```

## 3. Cập nhật phiên bản

Build + `docker save`/`docker load` như trên, rồi:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Compose tự tạo lại container có image mới; `migrate` chạy lại (migration đã áp dụng thì bỏ qua). Dọn image
cũ: `docker image prune -f`. Kiểm tra: `docker compose -f docker-compose.prod.yml ps` (api/web `healthy`).

## 4. Xem log

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=200 api worker
docker logs -f dezon-inbox-web
docker logs dezon-inbox-migrate
```

Log xoay vòng tự động (json-file 10 MB × 3 mỗi container).

## 5. Sao lưu / khôi phục

```bash
# Sao lưu DB (nén dạng custom)
docker exec dezon-inbox-db pg_dump -U dezon -d dezon_inbox -Fc > backup-$(date +%F).dump
# Khôi phục (DB trống; dừng api/worker trước)
docker compose -f docker-compose.prod.yml stop api worker
docker exec -i dezon-inbox-db pg_restore -U dezon -d dezon_inbox --clean --if-exists < backup-YYYY-MM-DD.dump
docker compose -f docker-compose.prod.yml start api worker
# Sao lưu tệp media (volume SeaweedFS)
docker run --rm -v dezon-prod_s3data:/data -v "$PWD":/backup alpine tar czf /backup/s3data-$(date +%F).tgz -C /data .
```

Nên đặt cron chạy `pg_dump` hằng ngày và chép bản sao ra ngoài VPS.

## 6. Cấu hình Meta App (developers.facebook.com)

| Mục                                                     | Giá trị                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Messenger → Webhooks → Callback URL                     | `https://alo.vuathau.com.vn/api/webhooks/messenger`                        |
| Verify token                                            | đúng giá trị `META_VERIFY_TOKEN` trong `.env.production`                   |
| Facebook Login for Business → Valid OAuth Redirect URIs | `https://alo.vuathau.com.vn/api/channels/messenger/oauth/callback`          |
| Settings → Basic → App Domains                          | `alo.vuathau.com.vn`                                                       |
| Settings → Basic → Privacy Policy / Site URL            | `https://alo.vuathau.com.vn`                                               |

Đăng ký lại các trường webhook (messages, messaging_postbacks, ...) sau khi đổi Callback URL. Các Page đã kết
nối vẫn dùng được nếu `ENCRYPTION_KEY` giữ nguyên.

## 7. Ghi chú kỹ thuật

- **Socket.IO** dưới tiền tố: web kết nối tới origin với `path=/api/socket.io`; Caddy bỏ `/api` nên API vẫn
  nghe `/socket.io`.
- **Cookie refresh** có `Path` tính từ `API_URL` (`/api/auth`), `Secure` + `HttpOnly` + `SameSite=Lax`.
- **Media**: URL ký bằng `S3_PUBLIC_ENDPOINT=https://alo.vuathau.com.vn` (path-style); Caddy chuyển nguyên
  path và Host tới SeaweedFS nên chữ ký SigV4 hợp lệ. Ghi S3 chỉ đi qua mạng nội bộ.
- **IP thật của khách**: muốn log thấy IP khách thay vì IP Cloudflare, thêm vào khối global của Caddy chung
  `servers { trusted_proxies static <dải IP Cloudflare> ; client_ip_headers CF-Connecting-IP X-Forwarded-For }`
  (xem https://www.cloudflare.com/ips/).
- **RAM**: giới hạn bộ nhớ mỗi container (`mem_limit`) tổng ~3 GB khi cao điểm; thực tế dùng ít hơn nhiều.
  Nếu VPS thiếu RAM nên bật swap 2 GB.
- **SeaweedFS** cổng master/filer (9333/8888) không có xác thực; container nằm trên mạng `qspro_default` nên
  các container khác trên mạng đó gọi được — chỉ để các app tin cậy trên mạng chung.
- **Thử trên máy dev**: `deploy/docker-compose.localproxy.yml` chạy một Caddy riêng với chứng chỉ nội bộ
  (`https://localhost:8443`) — xem chú thích trong file.
