# Zalo Official Account (OA) OpenAPI: verified facts for the connector (Giai đoạn 1B)

Researched: 2026-11-05. Sources are official Zalo pages only:

- developers.zalo.me (docs and changelog);
- zalo.solutions, which `zalo.cloud/oa/pricing` redirects to (Zalo Business Solutions pricing);
- the official GitHub SDKs `zaloplatform/zalo-php-sdk` and `zaloplatform/zalo-java-sdk`, used as secondary evidence only.

Quotes are copied from the live pages on that date. Screenshots referenced below are the ones embedded in the official docs.

**How to read the docs.** `developers.zalo.me/docs/...` is a JS shell. The real content is a Docusaurus site that is served in an iframe. Two ways to read a page:

- static HTML (the most reliable copy): `https://stc-developers.zdn.vn/docs/v2/<path>/index.html`;
- live page: `https://stc-developers.zdn.vn/docs/v2/<path>?lang=vi`.

The page list is in `https://stc-developers.zdn.vn/docs/sitemap.xml`. Changelog pages (`developers.zalo.me/changelog/...`) are rendered client-side.

Labels used below:

- **[DOC]**: stated by the official doc. Quotes are Vietnamese as on the page; an English gloss follows where useful.
- **[INFERENCE]**: our reading or recommendation. The doc does not say it outright.
- **[AMBIGUOUS]**: the docs disagree with each other, or are unclear.
- **[UNVERIFIED]**: not stated in any official source we found. Verify on a real OA before relying on it.

---

## 0. Summary: what changes vs. spec §2.1 / §6.5 / Giai đoạn 1B

| Spec assumption | Verified reality |
|---|---|
| ≤48 h free | **[DOC]** Since 1/1/2026, Tư vấn (CS) messages within 48 h are free and **unlimited**. The old cap of "8 free replies" is gone: `remain` is pinned to 8 from 1/1/2026, and after 1/3/2026 the field is no longer returned. |
| 48 h – 7 days paid | **[DOC]** These messages consume the package quota first: 500/month on the Tăng trưởng package, 2,000/month on Toàn diện. After that they cost **55 đ per message**, charged to a Zalo Cloud Account (ZCA) that is linked to the **App**. Without a ZCA you get error `-320`; an empty ZCA gives `-321`. |
| > 7 days blocked | **[DOC]** Error `-230` "User has not interacted with the OA in the past 7 days". `-232` is the generic "no interaction / interaction expired". |
| Signature "probably `sha256(appId + rawBody + timestamp + oaSecretKey)`" | **[DOC]** `mac = sha256(appId + data + timeStamp + OAsecretKey)`, where `data` is the JSON body string. This is a **plain SHA-256** of the concatenation, **not HMAC**; the official Java SDK `MacUtils` confirms it, with lowercase hex. The **OA Secret Key** sits on the app's Webhook page. It is **not** the App Secret. The header value may carry a `mac=` prefix **[AMBIGUOUS]**. |
| Token lifetimes ⚠️ | **[DOC]** Access token: **25 h** (`expires_in: "90000"`, a string). Refresh token: **3 months**, **single use**. "Access Token cũ sẽ hết hiệu lực ngay khi Access Token mới được tạo thành công" (the old access token stops working as soon as a new one is created). |
| `oa_send_*` events ⚠️ | **[DOC]** `oa_send_text`, `oa_send_image`, `oa_send_gif`, `oa_send_list`, `oa_send_file`, `oa_send_sticker`. They fire for messages sent "thông qua Open API hay từ cửa sổ chat OA Admin" (through the Open API or from the OA Admin chat window), **including our own API sends**. `sender.admin_id` is present only for messages sent from the OA chat tool. |
| Text ≈ 2,000 chars | **[DOC]** "Giới hạn tối đa là 2.000 ký tự" (maximum 2,000 characters). |
| Image by upload or URL | **[DOC]** Both work: `attachment_id` (from `/v2.0/oa/upload/image`) **or** `url`. Images must be **jpg/png, ≤ 1 MB**. |
| — (not in spec) | **[DOC]** **Paid OA package is mandatory for API use.** The OA must be **verified** and on the **Tăng trưởng** (2.5M đ/year) or **Toàn diện** (6M đ/year) package: "Để liên kết ứng dụng với OA thông qua API, bạn cần sử dụng Gói tăng trưởng hoặc toàn diện" (to link an app to the OA through the API, you need the Tăng trưởng or Toàn diện package). |
| — (not in spec) | **[DOC]** **Vietnam-IP rule (changelog v240229):** Zalo returns user personal data (name, avatar, shared phone/address…) only to apps **and webhook URLs with Vietnamese IP addresses**. ⇒ The production VPS must be **in Vietnam, not Singapore**. A Cloudflare quick tunnel may lose these fields (§3c). |
| — (not in spec) | **[DOC]** **Domain verification.** Every URL used with Zalo Platform must be on a verified domain or URL prefix. `*.trycloudflare.com` is **not** on the exemption list (`localtunnel.me`, `ngrok.io`, `localhost.run`, `serveo.net`). URL-prefix verification by an HTML file at the tunnel root works for us (§3). |

---

## 1. App setup, permissions, OA tiers, quotas

### 1a. Accounts involved [DOC]

From "Khám phá", https://developers.zalo.me/docs/official-account/bat-dau/kham-pha:

- **Zalo OA**: "tài khoản chính thức của Doanh nghiệp trên Zalo" (the business's official Zalo account).
- **Zalo App**: created at https://developers.zalo.me/createapp. "Sau khi tạo ứng dụng, Doanh nghiệp cần xác thực và cấp quyền cho ứng dụng" (after creating the app, the business must authenticate and grant it permissions).
- **Zalo Cloud Account (ZCA)**: "công cụ quản lý chi tiêu cho dịch vụ Zalo OA và ZNS" (the spending account for Zalo OA and ZNS). Link the ZCA to the OA and also to the App. "01 ZCA có thể link với nhiều OA và nhiều App" (one ZCA can link to many OAs and many Apps).
- "Admin (Quản trị viên) Zalo OA, Zalo App, ZCA là người dùng Zalo cá nhân … không nhất thiết phải cùng là một người dùng Zalo" (admins of the OA, the App and the ZCA are personal Zalo users, and need not be the same person).
- "Zalo không tính phí tích hợp Zalo OA … Tuy nhiên, Doanh nghiệp có thể cần trả phí gói OA và các tính năng." (Zalo does not charge for integration, but the business may need to pay for the OA package and features.)

### 1b. Creating and activating the app [DOC]

Pages: https://developers.zalo.me/docs/official-account/bat-dau/khoi-tao-ung-dung, plus screenshots on the "Mã lỗi" and webhook pages.

- **App settings (Cài đặt)** has these fields:
  - `ID ứng dụng`;
  - `Khóa bí mật của ứng dụng` (App Secret Key);
  - `Tên hiển thị`;
  - `Điện thoại liên hệ*`;
  - `Email liên hệ*`;
  - `Danh mục*`;
  - `Mô tả*`;
  - an optional icon;
  - a toggle **"Chưa kích hoạt" / "Đang hoạt động"** (inactive / active).
- Error `-209 "Not supported this api"` means the app is not activated. Fix: "Quản lý ứng dụng > Cài đặt > Bật 'Chưa kích hoạt' sang 'Đang hoạt động'".
- Error `-212 "App has not registed this api"`. Fix: "Quản lý ứng dụng > Đăng ký sử dụng API > Official Account API".
- **[INFERENCE]** There is **no Meta-style app review**. Activation, API registration, OA permission grants and the OA package are the gates.

Left menu of the app console, as in the screenshots:

- Cài đặt, Vai trò, Đăng ký sử dụng API, Xác thực domain, Thống kê API, Lịch sử;
- Products: Đăng nhập, **Webhook**, **Official Account** (sub-items "Thiết lập chung", "Quản lý OA", "Thống kê sản phẩm"), Mini App, Gọi thoại.

### 1c. Permission groups the OA grants to the app [DOC]

Source: the screenshot `app_request_perm_oa_1.jpg` on the OAuth page, and https://developers.zalo.me/docs/official-account/bat-dau/gioi-thieu-official-account-api-va-cac-nhom-quyen

"Quyền sử dụng API" (API permissions):

- **Quyền: Gửi tin nhắn**: "Gửi tin nhắn chủ động và gửi tin nhắn phản hồi; Upload hình ảnh, ảnh gif và file; Lấy thông tin quota…".
- **Quyền: Quản lý thông tin OA**: "Lấy thông tin OA; Lấy danh sách người dùng; **Lấy thông tin người dùng**; Cập nhật thông tin người dùng; Quản lý nhãn…".
- **Quyền: Quản lý tin nhắn người dùng**: "Lấy danh sách các hội thoại của OA; Lấy danh sách hội thoại với người dùng cụ thể".
- Others: ZNS, user custom fields, purchase, GMF groups, shop, articles, ads, calls.

"Quyền nhận sự kiện Webhook" (webhook event permissions):

- **Nhận sự kiện quản lý tin nhắn**: "Sự kiện người dùng đã nhận tin nhắn từ OA; … đã đọc tin nhắn; … gửi tin nhắn đến OA; Sự kiện OA gửi tin nhắn cho người dùng".
- **Nhận sự kiện quản lý người dùng**: "Sự kiện quản lý nhãn; … đồng ý chia sẻ thông tin; … quan tâm/bỏ quan tâm; … Widget cấp tương tác".

Changelog V260306, https://developers.zalo.me/changelog/v260310-thong-bao-cap-nhat-xac-thuc-nhom-quyen-doi-voi-appid-7886. From 06/03/2026, ZNS permissions were split. For our use case:

> "Gửi tin nhắn cơ bản (tin Tư vấn) … – Quyền gửi tin nhắn (b) – Quyền nhận sự kiện quản lý tin nhắn (e)"

**Permissions Dezon needs [INFERENCE]:**

- Gửi tin nhắn (b);
- Quản lý thông tin OA (profile);
- Quản lý tin nhắn người dùng (history sync);
- Nhận sự kiện quản lý tin nhắn (e);
- Nhận sự kiện quản lý người dùng (follow/unfollow, `user_submit_info`).

Leave everything else unticked.

### 1d. OA tiers and packages [DOC]

Original 2022 rule (changelog v220522, https://developers.zalo.me/changelog/v220522-trien-khai-phan-loai-tai-khoan-oa-goi-tra-phi-va-anh-huong-cua-thay-doi-tren-toi-quyen-su-dung-api-cua-oa-6726):

| Bộ API | OA Phổ thông (unverified) | OA Xác thực Cơ bản (no paid package) | OA Xác thực Nâng cao/Premium |
|---|---|---|---|
| Official Account API | ❌ | ❌ | ✅ |

Current pricing (https://zalo.solutions/oa/pricing; `zalo.cloud/oa/pricing` redirects there): "BẢNG GIÁ DỊCH VỤ OA – Dành cho OA đã xác thực" (OA service price list, for verified OAs).

| | Cơ bản (free) | Tiêu chuẩn 1,000,000 đ/year | **Tăng trưởng 2,500,000 đ/year** | Toàn diện 6,000,000 đ/year |
|---|---|---|---|---|
| Tích hợp Zalo Open API | — | — | ✅ | ✅ |
| API Rate Limit (per OA) | — | — | **100 req/phút** | 2,000 req/phút |
| Số lượng App được ủy quyền | 1 | 1 | **3** | Không giới hạn |
| Tin tư vấn ngoài khung 48h có sẵn/tháng | — | — | 500 | 2,000 |
| Số lượng tài khoản nhân viên | 3 | 5 | 15 | 100 |

The checkmarks are icons; we read the comparison table's DOM.

- FAQ: "Nếu tôi đang sử dụng phần mềm nội bộ hoặc bên thứ 3 (ứng dụng liên kết) … thì có cần mua gói không? — **Có. Để liên kết ứng dụng với OA thông qua API, bạn cần sử dụng Gói tăng trưởng hoặc toàn diện.**" (Do I need a package if I use internal or third-party software through the OA? Yes: linking an app to the OA through the API needs Tăng trưởng or Toàn diện.)
- FAQ: "Trường hợp gói hết hạn mà tài khoản không đủ tiền hoặc bạn không tiến hành gia hạn thì OA sẽ được chuyển về dùng gói Cơ bản." (If the package expires and is not renewed, the OA drops back to Cơ bản.) **[INFERENCE]** The API stops working then. Expect `-224`, and we should alert.
- Out-of-package price: "Tương tác cơ bản - Tin Tư vấn (Ngoài khung 48h) **55 đ/tin**" (CS message outside 48 h: 55 đ each).
- Related errors:
  - `-221` "The OA needs to be verified to use this feature";
  - `-224` "The OA needs to upgrade OA Tier Package to use this feature";
  - `-235` "This API does not support this type of OA".
- **[AMBIGUOUS]** The pricing table shows Cơ bản/Tiêu chuẩn with "1 App được ủy quyền", yet with no "Tích hợp Zalo Open API". We assume a free or Tiêu chuẩn OA can complete OAuth but most OA API calls fail with `-224`. Untested.
- "Mỗi OA có giới hạn số lượng App được ủy quyền nhất định" (each OA can authorise only a limited number of apps; OAuth page).

---

## 2. OAuth v4 for OA (PKCE)

Page: https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new

### 2a. Lifetimes and single-use rules [DOC]

- "Authorization Code chỉ được sử dụng 1 lần và có hiệu lực trong vòng **10 phút**" (single use, valid 10 minutes).
- "Thời hạn hiệu lực của Access Token: **25 giờ** (kể từ lúc được cấp mới)" (25 hours from issue).
- "Refresh Token **chỉ được sử dụng một lần** để tạo Access Token mới. Sau khi sử dụng thành công, Refresh Token cũ sẽ bị vô hiệu hóa và hệ thống trả về Refresh Token mới cho lần refresh tiếp theo." (Single use; after success the old one is invalid and a new one comes back.)
- "**Access Token cũ sẽ hết hiệu lực ngay khi Access Token mới được tạo thành công.**" (The old access token dies as soon as a new one is created.)
- "Thời hạn hiệu lực của Refresh Token: **3 tháng** (kể từ lúc được cấp mới)" (3 months from issue). "Trường hợp refresh token hết hạn, bạn cần thực hiện yêu cầu cấp lại authorization code" (if it expires, the OA admin must authorise again; Phụ lục "Các loại mã sử dụng trong OAuth").

Consequences:

- **[INFERENCE]** Exactly **one** valid access token and one valid refresh token exist per (App, OA) at a time.
- **[INFERENCE]** A refresh immediately breaks in-flight calls that use the old access token. They fail with `-216` or `-220`. Reload the token from the DB and retry once.
- **[UNVERIFIED]** What happens when an already-used refresh token is reused. The docs only say it "bị vô hiệu hóa" (is invalidated), with no error code given. Treat any token-endpoint error on refresh as fatal and set `status=expired`, but **only after** re-reading the DB under the lock, in case another worker already succeeded.
- **[INFERENCE]** Each refresh resets the 3-month clock on the new refresh token. A daily refresh job (spec 1B) keeps the connection alive indefinitely while the OA keeps a paid package.

### 2b. PKCE [DOC + SDK]

The doc:

> "Code verifier là 1 chuỗi bất kỳ, format có đủ chữ hoa, chữ thường, số và dài **43 ký tự**." (any string with upper case, lower case and digits, 43 characters long)
>
> "code_challenge = Base64.encode(SHA-256.hash(ASCII(code_verifier)))" … "encode Base64 (**without Padding**)"
>
> "Yêu cầu sử dụng code verifier khác nhau cho từng request." (Use a different code verifier for every request.) "Hãy dùng biến state … để xác định authorization code mà bạn nhận được ứng với code verifier nào." (Use `state` to know which verifier a returned code belongs to.)

The official SDKs use **base64url** (`+/` → `-_`) without padding:

- PHP `PKCEUtil::genCodeChallenge`: `strtr(trim(base64_encode(sha256_raw), "="), '+/', '-_')`;
- Java `Base64.getUrlEncoder().withoutPadding()`.

The PHP doc comment in `src/Authentication/OAuth2Client.php` and `ZaloRedirectLoginHelper.php` says: "The code challenge is a Base64-URL-encoded string of the SHA256 hash of the code verifier." The same Java `PKCEUtil` code is also published on developers.zalo.me ("Java SDK → Các hàm mã hóa thường dùng"), so base64url is officially endorsed, not just an SDK quirk.

- **[AMBIGUOUS → resolved by SDK]** The OAuth doc says "Base64"; both official SDKs and the official SDK doc page use base64url. This is standard S256 (RFC 7636).
- **No `code_challenge_method` parameter exists** in the doc, the console form or the SDK authorize URL (only `app_id`, `redirect_uri`, `code_challenge`, `state`). S256 is implicit. Do not add `plain`.
- `code_verifier` on the token call is "yes nếu ở bước 2 có thiết lập code challenge" (required only if a challenge was set), so PKCE is technically optional for Zalo. We always use it.
- **Implementation [INFERENCE]:** generate a 43-character verifier from `[A-Za-z0-9]` only. That satisfies both the doc's charset wording and RFC 7636. Then `challenge = base64url(sha256(verifier))` with no `=`.
- Store `{state → verifier, createdAt}` in Redis with a TTL of 10 minutes, matching the code lifetime.

### 2c. Authorize URL [DOC + SDK]

The console builds it under **Official Account → Thiết lập chung → "Đường dẫn yêu cầu cấp quyền"** (screenshot):

```
https://oauth.zaloapp.com/v4/oa/permission?app_id=<APP_ID>&redirect_uri=<urlencoded callback>&code_challenge=<challenge>&state=<state>
```

PHP SDK `OAuth2Client::getAuthorizationUrlByOA()`:

```php
$params = ['app_id' => …, 'redirect_uri' => $redirectUrl, 'code_challenge' => $codeChallenge, 'state' => $state];
return 'https://oauth.zaloapp.com' . '/v4' . '/oa/permission?' . http_build_query($params);
```

- The console form has three fields, **"Official Account Callback Url"**, **"Code Challenge"** and **"State"**, plus the permission checkboxes and **Lưu**.
- **[INFERENCE]** The console values are only a convenience link. Our app builds the URL dynamically with a fresh `code_challenge` and `state` per connect, as the SDK does.
- **[INFERENCE]** The permission set is **stored on the app**, not passed in the URL. The OA admin approves whatever is ticked in the console.
- **[UNVERIFIED]** Whether `redirect_uri` must equal the registered "Official Account Callback Url" exactly, or only share its verified domain or prefix. Set them **equal** to be safe.

### 2d. Callback [DOC]

> "Admin chọn tài khoản OA cần cấp quyền và chọn "Cho phép" … callback URL của bạn sẽ nhận được 1 HTTP get request có kèm authorization code và OA ID"
> (The admin picks the OA and clicks "Cho phép"; the callback receives a GET with the code and the OA ID.)
>
> `https://yourdomain.com/abc?code=<AUTHORIZATION_CODE>&oa_id=<OA_ID>`

- **[INFERENCE + SDK]** `state` is echoed back. The doc tells you to rely on it ("Hãy dùng biến state hoặc một param tự định nghĩa truyền vào redirect_uri"), and the official PHP SDK `ZaloRedirectLoginHelper` reads `code`, `state` and `code_challenge` from the callback query (`getInput('state')`, `getInput('code_challenge')`). The doc's example URL shows only `code` and `oa_id`. Reject the callback if `state` is unknown. Fallback if `state` turns out not to be echoed: the doc explicitly allows "một param tự định nghĩa truyền vào redirect_uri" (a custom query param inside `redirect_uri`), which URL-prefix verification ignores.
- **[SDK, UNVERIFIED on a real OA]** `code_challenge` is probably echoed as well (the PHP SDK reads it). Do not depend on it.
- `oa_id` becomes our `channel_accounts.external_id`.

### 2e. Token endpoint [DOC]

`POST https://oauth.zaloapp.com/v4/oa/access_token`, with `Content-Type: application/x-www-form-urlencoded` and the header **`secret_key: <App Secret Key>`**.

Exchange the authorization code:

```
code=<code>&app_id=<app_id>&grant_type=authorization_code&code_verifier=<verifier>
```

`code_verifier` is "yes nếu ở bước 2 có thiết lập code challenge" (required if a code challenge was set in step 2).

Refresh:

```
refresh_token=<refresh_token>&app_id=<app_id>&grant_type=refresh_token
```

Response, the same for both grants:

```json
{
  "access_token": "RfBh5NdqsWzhcX8bDDe_1A463Z34Fhy1GVi63AoTU1InwujqF",
  "refresh_token": "L2Y2BO9Prn_I1SkM08T4J99bZQYVbOBPfTVeRgrLdPK4ZqGX9G",
  "expires_in": "90000"
}
```

- `expires_in` is a **string** in seconds. The attribute table misspells it `expire_in`. Parse the number defensively.
- The response has no refresh-token expiry. Compute it as `issued_at + 3 months`.
- **[UNVERIFIED]** The error response format of the token endpoint is not documented for OA. The PHP SDK only checks that `access_token` is missing. Treat any HTTP 200 without `access_token` as an error, and log `error`/`error_name`/`error_description` if present.

### 2f. appsecret_proof (optional hardening) [DOC]

Changelog v240409:

> "Giá trị appsecret_proof là một mã băm SHA256 của access token sử dụng secret key của ứng dụng làm khóa"
> `$appsecret_proof = hash_hmac('sha256', $access_token, $app_secret_key);` … "thêm tham số appsecret_proof vào header"
> (appsecret_proof is an HMAC-SHA256 of the access token keyed with the app secret, sent as a header.)

- It is **not mandatory** unless "Yêu cầu kiểm tra app secret proof" is switched on in the app's Cài đặt.
- Bad value: error `-242`.
- **[INFERENCE]** Send it on every OA API call. It costs nothing and lets the owner turn enforcement on later.

---

## 3. Domain verification and local dev behind `*.trycloudflare.com`

Page: https://developers.zalo.me/docs/official-account/phu-luc/huong-dan-xac-thuc-domain. Changelogs v211220 and v211231.

### 3a. The rule [DOC]

> "Bạn cần xác minh domain của mình … trước khi bạn sử dụng cho các dịch vụ của Zalo Platform … Những domain và URL nằm trong danh sách xác thực mới có thể sử dụng cho các dịch vụ của Zalo Platform."
> (Verify your domain before using it with Zalo Platform services; only domains and URLs on the verified list can be used.)

Two modes:

- **Domain**: DNS TXT, HTML file, or meta tag.
- **Tiền tố URL** (URL prefix): HTML file or meta tag.

URL prefix behaviour:

> "Khi bạn xác thực với một URL (ví dụ: https://example.com/party/) thì Zalo Platform nhận định các URL có path con … đã được xác thực" … query strings are ignored.
> (Verifying a URL prefix covers every sub-path; query strings are ignored.)

URLs that end in a file name are cut back to the directory: "Đối với trường hợp URL có extension file (ví dụ: https://example.com/party/index.html) thì Zalo Platform sẽ bỏ qua phần path có extension file".

DNS TXT checks both the entered host and `zalo_verifier.<second-level domain>` (for `my-subdomain.example.com` it checks `my-subdomain.example.com` and `zalo_verifier.example.com`). For a `*.trycloudflare.com` host that would be `zalo_verifier.trycloudflare.com`, which we cannot control, so DNS TXT is impossible for quick tunnels.

Limits:

> "Số lượng domain tối đa xác thực cho một app là 20. Số lượng URL tối đa … là 20. Số kí tự tối đa cho một domain hoặc một URL là 75 kí tự."
> (Up to 20 domains and 20 URLs per app; each at most 75 characters.)

**Exemptions:**

> "Để hỗ trợ cho các developers phát triển nhanh ứng dụng, Zalo Platform **không kiểm tra xác thực domain** với các dịch vụ **localtunnel.me, ngrok.io, localhost.run, serveo.net**."
> (To help fast development, Zalo does not check domain verification for these tunnel services.)

**`trycloudflare.com` is not exempt.**

**[AMBIGUOUS]** Current ngrok free domains are `*.ngrok-free.app` / `*.ngrok.app`, not `ngrok.io`. Whether those are exempt is unknown.

### 3b. HTML file and meta tag details [DOC]

From the official screenshots `domain10.png`, `domain16.png` and `domain22.png`:

- **HTML file:**
  - Download `<CODE>.html` from the console. In `domain22.png` the download link is literally `NzMZ6DZWBoPUxQSXlPyp7MULwIgBv3XmDZG.html` (no prefix).
  - Serve it so that it is reachable at **`https://example.com/zalo_verifier<CODE>.html`**. For a URL prefix: `https://example.com/party/zalo_verifier<CODE>.html`. Re-checked 2026-11-05 on `domain22.png`: "Chú ý: Tệp xác minh HTML của bạn được tải lên thành công nếu bạn có thể thấy trang HTML đã tải xuống trên website của bạn: https://example.com/party/zalo_verifierNzMZ6DZWBoPUxQSXlPyp7MULwIgBv3XmDZG.html". So the **served path adds a `zalo_verifier` prefix** to the downloaded file name.
  - "Để duy trì trạng thái xác minh, không xóa tệp ngay cả sau khi xác minh thành công." (Do not delete the file, even after success.)
- **Meta tag:**
  - `<meta name="zalo-platform-site-verification" content="<CODE>" />` in `<head>` of the root page.
  - "chúng ở quá xa và vượt quá kích thước cho phép thu thập từ Zalo (512kb) thì sẽ không lấy được. **Bỏ chặn request từ các IP nước ngoài.**" (If the tag is past the first 512 KB it is not found. Unblock requests from foreign IPs.) This note is printed only in the meta-tag step of `domain16.png`, but the same crawler probably fetches the HTML file. **[INFERENCE]** Do not geo-block or put Cloudflare WAF/bot rules in front of the verifier path.
  - "Có thể mất tới **72 giờ** để Zalo Platform tìm thấy thẻ meta." (It can take up to 72 hours to find the tag.)
- **[UNVERIFIED]** The exact contents of the downloaded HTML file. Serve its bytes verbatim, with `Content-Type: text/html`.

### 3c. What this means for `https://<random>.trycloudflare.com → localhost:4000` [INFERENCE]

1. **Webhook URL.** "Webhook Url không nên dùng host:port, thay vào đó hãy dùng domain và phải được cấu hình https." (Do not use host:port; use an HTTPS domain.) A trycloudflare URL is fine on that count.
2. **Verification.** We cannot add DNS records to `trycloudflare.com`, so use **URL-prefix verification of `https://<random>.trycloudflare.com/` with the HTML file**.
   - Our API serves `GET /zalo_verifier<CODE>.html` at the root, returning the file's content from an env var, for example `ZALO_SITE_VERIFICATION_FILE=<filename>|<content>`. Note: the owner downloads `<CODE>.html`, but our route must be `/zalo_verifier<CODE>.html` (§3b). Make the route match `/zalo_verifier*.html` and answer `200 text/html` with no auth, redirect or cookie wall.
   - The 75-character limit applies to the verified URL entry. `https://<4 random words>.trycloudflare.com/` is usually 50–65 characters, so it fits. Check the length before pasting.
   - Prefer the file to the meta tag, because of the meta tag's 72-hour note.
   - **[UNVERIFIED]** Whether the console accepts plain *domain* verification of a single `*.trycloudflare.com` host by HTML file. The URL-prefix route avoids the question.
3. **The quick-tunnel hostname changes on every `cloudflared` restart.** After each restart:
   - re-verify the new prefix;
   - re-enter the **Webhook URL** and the **Official Account Callback Url**;
   - delete the old prefix, since the cap is 20.

   This is painful. Better options:
   - **(a)** A **named Cloudflare Tunnel** on a fixed hostname such as `zalo-dev.dezon.vn`. This needs the `dezon.vn` DNS zone on Cloudflare. Verify once with DNS TXT or the HTML file.
   - **(b)** An ngrok static domain. Exemption uncertain, see 3a.
4. **Is verification enforced for the webhook URL and the OA callback URL specifically?** The docs say all URLs used with Zalo Platform must be verified. The original research reported that the webhook screenshot's status bar links to `/app/<id>/verify-domain`. That link was not visible in `webhook_4.jpg` when re-checked on 2026-11-05. **[UNVERIFIED]** that saving an unverified webhook or callback URL is rejected. Assume it is.
5. **Vietnam-IP rule.** See §8b. Cloudflare's edge IPs are anycast and most likely geolocated outside Vietnam. Expect user personal fields in **webhooks** to be blanked while on the quick tunnel; for example the `info` of `user_submit_info`.
   - API calls (`user/detail`, `conversation`) are made **from the dev machine**. They egress from a Vietnamese ISP IP and should be unaffected.
   - "Bạn có thể kiểm tra IP webhook tại trang Developer, vào phần Quản lý Ứng dụng → Thiết lập webhook → Nhập webhook URL." (You can check the webhook IP in the app's webhook settings.) Check what the console says for the tunnel URL.

---

## 4. Webhook

Overview: https://developers.zalo.me/docs/official-account/webhook/tong-quan

### 4a. Configuration [DOC]

App console → **Webhook**:

- "Webhook URL" with a **Thay đổi** button.
- "**OA Secret Key**" (masked, with a **Reset** button).
- "**Webhook Retry**" toggle.
- "**Lọc cú pháp**" toggle: "Nếu bạn bật tính năng 'Lọc cú pháp', webhook của bạn chỉ có thể nhận được các tin nhắn text bắt đầu bằng '#'" (only text messages starting with "#" are delivered). **Keep it OFF.**
- "Danh sách sự kiện webhook": a table with one **Tắt/Bật** (off/on) toggle and a **Test** button per event. The screenshot shows `user_send_location`, `user_send_image`, `user_send_link`, `user_send_text`, `user_send_sticker`, `user_send_gif`, `user_received_message`, `user_seen_message`…
- "Official Account phải tiến hành cấp Official_Account_Access_Token cho App đang liên kết để có thể nhận về các sự kiện." (The OA must have authorised the app before events arrive.)

**[INFERENCE]** There is **one webhook URL and one OA Secret Key per App**, shared by every OA the app is linked to. Route events by OA id (§4e).

### 4b. Response time, retries, disabling [DOC]

> "Phản hồi tất cả sự kiện webhook với http status code = 200 OK. Phản hồi tất cả sự kiện webhook tối đa **2 giây**."
> (Answer every event with 200 OK within 2 seconds.)
>
> "Zalo hỗ trợ gửi lại sự kiện … đối với những sự kiện gửi không thành công (Không mở được connection tới webhook url)… sau 30 giây, sau 5 phút, sau 15 phút, sau 30 phút, sau 1 giờ. Các sự kiện đó với nội dung hoàn toàn tương tự, nhưng sẽ có truyền thêm ở header của request trường "**num_retry**"."
> (Failed deliveries are resent after 30 s, 5 min, 15 min, 30 min and 1 h, with identical content plus a `num_retry` header.)
>
> "Nếu webhook của bạn tiếp tục không đáp ứng … ứng dụng của bạn sẽ bị **hủy đăng ký nhận các sự kiện webhook** cho Offical Account. Sau khi khắc phục sự cố … Bạn cần xin quyền nhận sự kiện lại trong trang cài đặt của ứng dụng."
> (If it keeps failing, the app is unsubscribed from events for the OA, and you must request event permissions again in the app settings.)

**[INFERENCE]:**

- Our "verify → enqueue → 200" path (spec 6.1) fits. Keep it under 1 s.
- **Retries are documented only for connection failures** ("Không mở được connection tới webhook url"). Nothing says a non-200 status or a slow (> 2 s) answer triggers a retry. Missing the 200/2 s requirements only produces a "webhook không hoạt động" (webhook not working) notice to the app admin's Zalo account. **Do not rely on returning 5xx to get an event redelivered.** Once the request is accepted, persist it before answering. The history API (§7) is the only recovery path.
- Retries carry **the same body and the same `timestamp`**, so the same signature. **Do not** reject old timestamps with a short replay window. Allow at least about 2 h, or skip the age check and rely on dedupe by `msg_id`.
- On the quick tunnel, Zalo may disable the webhook while the tunnel is down. Re-enable the events in the console afterwards.

### 4c. Signature `X-ZEvent-Signature` [DOC + SDK]

Every webhook page says:

> "X-ZEvent-Signature: mac = sha256(appId + data + timeStamp + OAsecretKey), với data là chuỗi json trả về dưới đây."
> (… where `data` is the JSON string returned below.)

Official Java SDK `com.vng.zalo.sdk.utils.MacUtils.buildMac(appId, data, timeStamp, secretKey)` concatenates the four strings and returns lowercase hex `SHA-256` (`MessageDigest.getInstance("SHA-256")`). This is **not** an HMAC.

Additional official evidence, re-checked 2026-11-05:

- The developers.zalo.me page "Java SDK → Các hàm mã hóa thường dùng" (https://developers.zalo.me/docs/sdk/java-sdk/tai-lieu/cac-ham-ma-hoa) publishes the same `buildMac(appId, data, timeStamp, secretKey)` code under the heading **"build X-Event-Signature"**. The heading writes "X-Event", but every webhook page writes `X-ZEvent-Signature`. **[INFERENCE]** The header is `X-ZEvent-Signature`, and the SDK page heading is a typo. If the header is missing, fall back to reading `x-event-signature` and log which header was present.
- Official .NET SDK `ZaloDotNetSDK/src/sdk/utils/MacUtils.cs`: `buildMac(string value)` = `SHA256(Encoding.UTF8.GetBytes(value))`, lowercase hex. The caller builds the concatenated string (doc page https://developers.zalo.me/docs/sdk/dotnet-sdk/tai-lieu/cac-ham-ma-hoa: `MacUtils.buildMac(webhookBody)`). This confirms **plain SHA-256 over UTF-8 bytes, lowercase hex**.
- No official source (docs, Java/.NET/PHP SDK) states which timestamp is used, or whether the header value carries a `mac=` prefix. Both remain **[UNVERIFIED]** until the first live event.

The fields:

- `appId`: our App ID. It also appears as `app_id` in the body. Reject if the body's `app_id` differs from `ZALO_APP_ID`.
- `data`: **[INFERENCE]** the **raw request body string**, exactly as received. Never a re-serialised `JSON.stringify(JSON.parse(body))`: key order, spacing and escaping could differ.
- `timeStamp`: **[INFERENCE]** the body's top-level `"timestamp"` field (a string, in ms). No timestamp header is documented. The only documented extra header is `num_retry`.
- `OAsecretKey`: the **"OA Secret Key"** on the app's Webhook page (screenshot `webhook_4.jpg`), i.e. our `ZALO_OA_SECRET_KEY`. **Not** the App Secret. It can be **Reset** in the console, which breaks verification until the env is updated.

**[AMBIGUOUS]** The docs write "X-ZEvent-Signature: mac = sha256(…)". That could mean:

- the header value is the bare hex, with "mac" just the variable name; or
- the header value is `mac=<hex>`.

No official SDK parses the header: `MacUtils` has no callers in the Java, .NET or PHP SDK source, and the PHP SDK has no MAC helper at all. Community integrations (non-official, **[UNVERIFIED]**) report the value as `mac=<hex>`. We could not find a public source for that report on 2026-11-05. Accept both: strip an optional leading `mac=` (case-insensitive, trimmed), then constant-time compare with the lowercase hex.

**[INFERENCE] Debug fallback for the first live event.** If the primary formula fails, compute and log (never accept) these variants, then fix the code to whichever matches:

- the timestamp taken from a header instead of the body;
- `data` re-serialised compactly instead of the raw body.

Do not ship a multi-variant acceptor.

Sketch:

```ts
const raw = req.rawBody; // Buffer, unmodified
const body = JSON.parse(raw.toString('utf8'));
const ts = String(body.timestamp ?? '');
const expected = createHash('sha256')
  .update(Buffer.concat([Buffer.from(appId), raw, Buffer.from(ts), Buffer.from(oaSecretKey)]))
  .digest('hex');
const got = String(headers['x-zevent-signature'] ?? headers['x-event-signature'] ?? '').trim().replace(/^mac\s*=\s*/i, '').toLowerCase();
ok = got.length === 64 && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
```

**First live test:** use the console **Test** button and a real message. Log the header (it is not a secret) and confirm the format.

### 4d. Event payloads [DOC]

The common envelope:

- `event_name`;
- `app_id`;
- `timestamp`: a string in ms. "Thời điểm request được gửi" (the time the request is sent), **not** the message time. **[INFERENCE]** Use it as `sentAt` anyway, since retries keep the same value. One doc example has a 12-digit typo (`154390853474`).

**User → OA (`user_send_*`).** https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan

```json
{
  "app_id": "360846524940903967",
  "sender": { "id": "246845883529197922" },
  "user_id_by_app": "552177279717587730",
  "recipient": { "id": "388613280878808645" },
  "event_name": "user_send_text",
  "message": { "text": "message", "msg_id": "96d3cdf3af150460909" },
  "timestamp": "154390853474"
}
```

- `sender.id` is the user (UID scoped to the OA). `recipient.id` is the OA.
- Documented `event_name` values:
  - `user_send_text`, `user_send_image`, `user_send_link`, `user_send_audio`, `user_send_video`, `user_send_sticker`, `user_send_location`, `user_send_business_card`, `user_send_file`;
  - plus `user_send_gif`, which is in the console event list and has a documented `gif` attachment shape.
- "Nếu tin nhắn được gửi là tin nhắn đa phương tiện … thì sẽ có thêm thuộc tính attachments." "Nếu … có thuộc tính "quote_msg_id" thì tin nhắn này được gửi qua "Trả lời"." (Media messages carry `attachments`; a `quote_msg_id` means the message is a reply.)

`message.attachments[]` shapes:

| type | payload |
|---|---|
| `image` | `{ "thumbnail": "http://t.f6.photo.talk.zdn.vn/….jpg", "url": "http://f6.photo.talk.zdn.vn/….jpg" }` |
| `gif` | `{ "thumbnail": "http://cgif.zp.zdn.vn/…_t.jpg", "url": "http://cgif.zp.zdn.vn/…_n.gif" }` |
| `link` | `{ "thumbnail": "…", "description": "…", "url": "https://developers.zalo.me/" }` |
| `audio` | `{ "url": "http://f1.voice.talk.zdn.vn/…/….amr" }` (AMR) |
| `video` | `{ "url": "https://f4-zvc.zdn.vn/…", "thumbnail": "…", "description": "" }` |
| `sticker` | `{ "url": "https://api.zalo.me/api/emoticon/oasticker?eid=…&size=130", "id": "e1540df031b5deb81a4" }` |
| `location` | `{ "coordinates": { "latitude": "10.7642473", "longitude": "106.65643139999999" } }` |
| `file` | `{ "size": "233947", "name": "developer.docx", "checksum": "<md5>", "type": "docx", "url": "https://f7-group-zf.zdn.vn/…" }` |

- **[INFERENCE]** Some media URLs are plain `http://`. Download them into S3 immediately (spec 6.1 step 5). No expiry is documented.
- **[UNVERIFIED]** The `user_send_business_card` payload is not documented. Store it raw and render it as "[Danh thiếp]".
- **[INFERENCE]** Whether text accompanies image messages is not documented. Read `message.text` if present.

**OA → user (`oa_send_*`), including our own sends.** https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-official-account-gui-tin-nhan-cho-nguoi-dung

> "Khi Official Account gửi tin nhắn đến người dùng thông qua Open API hay từ cửa sổ chat OA Admin…"
> (When the OA sends a message through the Open API or from the OA Admin chat window…)

```json
{
  "app_id": "360846524894903967",
  "sender": { "id": "388613280879808645", "admin_id": "4267886274574868951" },
  "recipient": { "id": "246845883529197922" },
  "event_name": "oa_send_text",
  "message": { "text": "message", "msg_id": "465928106db72e8cba7" },
  "user_id_by_app": "552177279717587730",
  "timestamp": "1543980770426"
}
```

- `sender.id` is the OA. `recipient.id` is the user.
- `app_id`: "Id ứng dụng ứng với access_token gọi API gửi tin nhắn" (the app whose access token sent the message).
- `admin_id`: "Chỉ có khi OA gửi tin nhắn bằng tool chat OA - https://oa.zalo.me/chatv2" (only when sent from the OA chat tool).
- `user_id_by_app`: "chỉ có khi app_id chỉ ứng dụng đang liên kết với Official Account nhận sự kiện" (only when `app_id` is the app linked to the OA receiving the event).
- Event names: `oa_send_text`, `oa_send_image`, `oa_send_gif`, `oa_send_list`, `oa_send_file`, `oa_send_sticker`. A "template" (ZBS) attachment shape is also documented.

**[INFERENCE]** How to classify an `oa_send_*` event:

| Condition | Meaning | Action |
|---|---|---|
| `app_id == ZALO_APP_ID` | Our own API send. The echo of a message we already stored. | Match `msg_id` to `messages.external_message_id`. If the worker has not stored the id yet, apply the race rule from the Messenger doc. |
| `admin_id` present | A staff member replying in OA Manager. | Store with `sender_type = agent`, label "OA Manager". This pauses the AI (spec 6.4). |
| `app_id` is another app, no `admin_id` | Another tool or chatbot. | Store with `sender_type = agent`, label "Ứng dụng khác". |

**Delivery and read.** https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-nhan-tin-nhan-tu-official-account and …/su-kien-nguoi-dung-da-xem-tin-nhan-duoc-gui-tu-official-account

```json
{ "app_id": "…", "sender": { "id": "<OA id>" }, "recipient": { "id": "<user id>" },
  "event_name": "user_received_message", "message": { "msg_id": "43b59c025aebfb5e6fa" }, "timestamp": "1540363714911" }
{ "app_id": "…", "sender": { "id": "<OA id>" }, "recipient": { "id": "<user id>" },
  "event_name": "user_seen_message", "message": { "msg_ids": ["43b59c025aeabfb5e6fa"] }, "timestamp": "1540363714987" }
```

- Note: **`sender` is the OA here**.
- "Sự kiện này chỉ được gửi về khi user nhận tin nhắn trên Zalo Mobile." (Sent only when the user receives the message on Zalo Mobile.)
- `user_seen_message` is sent only for viewing on Zalo Mobile, and "**Chỉ gửi đến Webhook của App nào đã gửi tin nhắn đó đi**" (only to the webhook of the app that sent that message).
- **[INFERENCE]** Map them to `InboundEvent` `delivery` (explicit ids) and `read`. Read events carry explicit `msg_ids`, not a watermark: use `timestamp` as the watermark, or extend the type to accept ids.

**Follow and unfollow.** https://developers.zalo.me/docs/official-account/webhook/quan-ly/su-kien-nguoi-dung-quan-tam-hay-bo-quan-tam-oa

```json
{ "oa_id": "388613280879808645", "follower": { "id": "24684588352919792" },
  "user_id_by_app": "552172779717587730", "event_name": "follow", "source": "oa_profile",
  "app_id": "36084652489903967", "timestamp": "154397978274" }
```

- `event_name` is `follow` or `unfollow`.
- `source` is `oa_profile`, `message_invite` or `social_plugin`.
- Following counts as an interaction, so the OA may send a greeting (§5e).

**User clicked "Nhắn tin" (Message).** https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-click-nut-nhan-tin-tren-official-account

```json
{ "app_id": "…", "event_name": "user_click_chatnow", "oa_id": "…", "user_id": "…", "user_id_by_app": "…", "timestamp": "1636707354448" }
```

"chỉ gửi 1 lần / 1 user / 1 OA và user đó chưa từng có lịch sử chat với OA" (sent once per user per OA, only if the user has never chatted with the OA).

**`user_submit_info`** (user filled in the OA's info-request form). https://developers.zalo.me/docs/official-account/webhook/quan-ly/su-kien-nguoi-dung-dong-y-chia-se-thong-tin

```json
{ "sender": { "id": "<user>" }, "recipient": { "id": "<OA>" }, "event_name": "user_submit_info",
  "app_id": "…", "timestamp": "1540368141908",
  "info": { "name": "Name Example", "phone": "84912345678", "user_dob": "30/10/1999", "gender": "Nam",
            "full_address": { "user_city": "…", "user_ward": "…", "user_address": "…" } } }
```

These are exactly the fields stripped for non-Vietnamese webhook IPs (§8b).

**Reactions.** `user_reacted_message` and `oa_reacted_message`:

```json
{ "app_id": "…", "event_name": "user_reacted_message", "sender": { "id": "<user>" }, "recipient": { "id": "<OA>" },
  "message": { "msg_id": "789f573aecf8a9a4f0eb", "react_icon": ":-h" }, "timestamp": "1637119864504", "user_id_by_app": "…" }
```

**Anonymous users.** https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-an-danh-gui-tin-nhan

- `anonymous_send_text|image|file|sticker`.
- `sender.id` is an anonymous id such as `"1ffedc467f179649cf06"`, not a numeric UID.
- `message.conversation_id` is required to reply.
- Replies go to `POST https://openapi.zalo.me/v2.0/oa/message` with `recipient: { anonymous_id, conversation_id }`.
- There are also `oa_send_anonymous_*` events.
- **[INFERENCE]** Out of scope for 1B. Log and ignore, or store as an "ẩn danh" conversation keyed by `conversation_id` in a later phase.

**Data-subject request.** `user_withdraw`:

```json
{ "app_id": "…", "oa_id": "…", "user_id_by_app": "…", "user_id": "…", "event_name": "user_withdraw", "timestamp": "1727770763679" }
```

> "Khi người dùng Zalo yêu cầu thực hiện quyền chủ thể dữ liệu … (rút lại sự đồng ý; xoá dữ liệu; hạn chế xử lý; phản đối xử lý) … thông báo … để tiến hành xóa dữ liệu tương ứng."
> (When a Zalo user exercises data-subject rights — withdrawing consent, deleting data, restricting or objecting to processing — Zalo notifies partners so they delete the matching data.)

Per the attribute table, `oa_id` and `user_id` are `""` when the app is not linked to an OA ("Nếu app chưa liên kết với OA, sẽ trả oa_id = “”"). In that case only `user_id_by_app` identifies the user.

**[INFERENCE]** This matches the "xóa dữ liệu một khách" (delete one customer's data) task in Giai đoạn 1D. Subscribe to it and queue a deletion. Match on `user_id` + `oa_id`, falling back to `user_id_by_app` (so store `user_id_by_app` on the contact, not only in `raw`).

### 4e. Ids and routing [DOC + INFERENCE]

- **UID** (`sender.id`, `recipient.id`, `follower.id`, `user_id`): "ID của người dùng gắn với OA" (the user id scoped to the OA). This is the id that `message/cs` (`recipient.user_id`) and `user/detail` expect. **Use it as `externalUserId`.** The same person has a different UID on each OA.
- **`user_id_by_app`**: "ID của người dùng gắn với App" (scoped to the app; used by the Social API). Store it in `raw` only.
- **OA id**, by event:
  - user→OA events: `recipient.id`;
  - OA→user, delivery and read events: `sender.id`;
  - follow and `user_click_chatnow`: `oa_id`.

  Use it for `AccountResolver('zalo_oa', oaId)`.
- **`msg_id`** is `externalMessageId`. It equals the `message_id` returned by `message/cs` **[INFERENCE]**; verify with the first echo.
- All ids are **strings of digits** larger than 2^53. **Never parse them as numbers.** The history API docs type `from_id`/`to_id` as "long", but the example values are strings (§7).

---

## 5. Sending Tư vấn (consultation) messages

### 5a. Text [DOC]

https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-dang-van-ban

```
POST https://openapi.zalo.me/v3.0/oa/message/cs
Content-Type: application/json
access_token: <OA access token>

{ "recipient": { "user_id": "2512523625412515" }, "message": { "text": "hello, world!" } }
```

`text`: "Giới hạn tối đa là **2.000 ký tự**" (2,000 characters at most).

Success response; the `data.quota` object varies:

```json
{ "data": { "quota": { "quota_type": "reply", "remain": "8", "total": "8" },
            "message_id": "63ecf43f0df7dba892e6", "user_id": "2512523625412515", "sent_time": "1626926349402" },
  "error": 0, "message": "Success" }
```

`quota_type` values:

| `quota_type` | Meaning |
|---|---|
| `reply` | Inside the 48 h window: free. "Từ ngày 1/1/2026, đối tác có thể gửi tin Tư vấn miễn phí không giới hạn trong khung 48h… Sau ngày 1/3/2026: sẽ dừng trả về thuộc tính này." (Unlimited free CS in 48 h from 1/1/2026; the field is dropped after 1/3/2026.) |
| `welcome_msg` | "Tin gửi đến User Quan tâm (khi chưa có tương tác)" (to a follower with no interaction yet), with `remain`/`total`; the example shows 2/3. |
| `sub_quota` | The OA package's free outside-48 h quota, with `remain`, `total`, `expired_date`. |
| `purchase_quota` / `reward_quota` | Bought or gifted quota, with `owner_type` (OA or App) and `owner_id`. |
| no `quota` object | "Tin gửi ra là tin **tính phí**" (a charged message). |

**[INFERENCE]** Read `costly` after the fact from the response: `quota_type ∈ {sub_quota, purchase_quota, reward_quota}`, or no quota object. Store it in `messages.raw` for the cost report. The pre-send `costly` flag still comes from our 48 h computation (§5e).

### 5b. Image [DOC]

https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/gui-tin-tu-van-dinh-kem-anh

```json
{ "recipient": { "user_id": "2468458835296117922" },
  "message": { "text": "Zalo đạt 100 triệu người dùng",
    "attachment": { "type": "template",
      "payload": { "template_type": "media",
        "elements": [{ "media_type": "image", "url": "https://stc-developers.zdn.vn/images/bg_1.jpg" }] } } } }
```

- `text` is an optional caption, ≤ 2,000 characters.
- `elements`: "tối đa 1 phần tử" (one element at most).
- `media_type` is `image` or `gif`. For `gif`, `width` and `height` are required.
- `attachment_id` **or** `url`: "chỉ sử dụng 1 trong 2 biến attachment_id hoặc url" (use only one of the two). "Các định dạng ảnh hỗ trợ: **jpg và png**. Dung lượng tối đa: **1MB**." "kích thước ảnh tối ưu 16:9" (jpg and png only, 1 MB max; 16:9 is the recommended aspect ratio).
- **[INFERENCE]** Use **upload → `attachment_id`**. A `url` would require our S3 objects to be publicly reachable by Zalo, which the tunnel and the local SeaweedFS are not.
- **[INFERENCE]** Our pipeline resizes images to ≤ 1600 px, which can exceed 1 MB. Re-encode to JPEG and step the quality down until the file is ≤ 1 MB. Convert webp/heic to JPEG.

### 5c. Upload APIs [DOC]

All need "Quyền gửi tin và thông báo qua OA" (permission to send messages via the OA). All are `multipart/form-data` with the field `file` and the header `access_token`.

| Endpoint | Formats / size | Response | Monthly quota |
|---|---|---|---|
| `POST https://openapi.zalo.me/v2.0/oa/upload/image` | jpg, png; ≤ 1 MB | `{"data":{"attachment_id":"…"},"error":0}` | 5000 requests |
| `POST https://openapi.zalo.me/v2.0/oa/upload/gif` | gif; ≤ 5 MB | `{"data":{"attachment_id":"…"}}`. The table calls it `token`. | 5000 requests. The page also says "Quota cho API là không giới hạn" (unlimited) **[AMBIGUOUS]**. |
| `POST https://openapi.zalo.me/v2.0/oa/upload/file` | "Chỉ hỗ trợ file **PDF/DOC/DOCX/CSV**, dung lượng file không vượt quá **5MB**" (PDF/DOC/DOCX/CSV only, ≤ 5 MB) | `{"data":{"token":"…"}}` | 5000 requests |

> "Ảnh sau khi được upload và gửi đến người dùng sẽ được lưu trên server tối đa **7 ngày**."
> (Uploaded files are kept on Zalo's server for at most 7 days.)

Error `-100`: "attachment_id was expired". Re-upload and retry once.

### 5d. File message [DOC]

```json
{ "recipient": { "user_id": "…" }, "message": { "attachment": { "type": "file", "payload": { "token": "<token from upload/file>" } } } }
```

**[INFERENCE]** Video, audio and other file types (xlsx, zip, mp4…) **cannot** be sent as CS attachments. Throw `PermanentSendError('unsupported_attachment')`, and have the UI block them for Zalo OA.

### 5e. Window rules [DOC]

Tin nhắn overview, https://developers.zalo.me/docs/official-account/tin-nhan/tong-quan:

> Tin Tư vấn – "Điều kiện để gửi tin: Người dùng có phát sinh tương tác với OA trong vòng **7 ngày** và đang không chặn OA" (the user interacted with the OA within 7 days and is not blocking it)
>
> Chi phí: "Trong vòng 48 giờ kể từ tương tác cuối của người dùng, tin Tư vấn hoàn toàn miễn phí. Sau 48 giờ … giá tin Tư vấn được tính theo bảng giá" (free within 48 h of the last interaction; priced per the price list after that)

Interactions that open the window:

- "Gửi tin nhắn đến OA";
- "Gọi thoại đến OA";
- "Bình luận bài viết";
- "Tương tác với OA Chatbot";
- "Nhấn Menu, CTA query hoặc Widget".
- Also on the current overview page (re-checked 2026-11-05): "Gửi tin nhắn trong nhóm chat GMF" and "Đồng ý nhận cuộc gọi từ OA" (sending a message in the OA's GMF group chat, or accepting a call from the OA).

**[AMBIGUOUS] Stale page.** `…/quan-ly-tin-nhan/kiem-tra-tin-tu-van-trong-khung-48h` (v2.0 `POST /v2.0/oa/quota/message` keyed by `message_id`) still says "OA được miễn phí 08 Tin Tư vấn gửi trong khung 48 giờ … Sau 08 tin hoặc sau 48 giờ, tin Tư vấn … được tính vào hạn mức". That is the pre-2026 rule. The newer `message/cs` and v3 `quota/message` pages say CS messages in 48 h are free and unlimited from 1/1/2026. Trust the newer pages, and do not call the v2 endpoint.

"Quan tâm OA, Nhấn nút Nhắn tin trên trang Thông tin OA" (following the OA, or tapping "Nhắn tin" on its profile) only allow a greeting "ngay sau khi người dùng thực hiện hành động" (right after the action).

CS conditions page (https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/dieu-kien-gui-tin-tu-van):

- "App: đã bật quyền gửi tin và thông báo qua OA";
- "User (người nhận tin): có tương tác với OA trong vòng 7 ngày";
- "Thời gian gửi tin: 24/24" (any hour);
- shown on Mobile and PC/Web.

**Following the OA is not required.** The user only needs a recent interaction.

**Authoritative last-interaction time:** `POST https://openapi.zalo.me/v3.0/oa/quota/message` with `{"user_id": "…"}`:

```json
{ "data": { "last_interaction": "1690184100000", "cs_reply": { "remain": 8, "total": 8 },
            "promotion": { "daily_remain": 0, "daily_total": 1, "monthly_remain": 4, "monthly_total": 6 } },
  "error": 0, "message": "Success" }
```

"Lưu ý: Người dùng không cần quan tâm OA" (the user need not follow the OA).

**ChannelPolicy for Zalo OA [INFERENCE]:**

- `last_customer_message_at ≤ 48 h` → allowed.
- 48 h to 7 days → allowed, `costly = true`.
- More than 7 days → blocked.
- If our clock disagrees with Zalo (for example the user clicked a menu, or commented on an article we do not track), Zalo's answer wins:
  - `-230` / `-232` → `PermanentSendError(reason='outside_window')`;
  - optionally call `quota/message` before a costly send to refresh `last_interaction`.

### 5f. Error codes and retry classification

Source: Mã lỗi, https://developers.zalo.me/docs/official-account/phu-luc/ma-loi. Messages are quoted exactly.

| Code | Message | Our class [INFERENCE] |
|---|---|---|
| 0 | Success | — |
| -32 | "Your application reached limit call api" / "Your OA reached limit call api" | **Transient.** Back off until the next minute. |
| -100 | "attachment_id was expired" | Transient once: re-upload, then retry. |
| -200 | "Send message failed" | Transient. Retry up to 3 times; it is unclear what causes it. |
| -201 | "<data_field> is invalid!" | Permanent: bad request. |
| -204 / -205 | "Offical Account is disable" (Vietnamese description: "Official Account đã bị xóa", the OA was deleted) / "…is not exist" | Permanent, credentials (`credentialsInvalid`). |
| -209 | "Not supported this api" (app not activated) | Permanent, credentials (config). |
| -210 | "Parameter exceeds allowable limit" | Permanent: bad request, e.g. text > 2,000 characters. |
| -211 | "Out of quota" | Permanent: quota or billing. |
| -212 | "App has not registed this api" | Permanent, credentials (config). |
| -213 | "User has not followed OA" | Permanent: recipient. |
| -216 | "Access token is invalid" | **Credentials.** Reload the token from the DB. If it changed, retry once; else mark `expired`. |
| -217 | "User has blocked invitation from OA" | Permanent: recipient. |
| -218 | "Out of quota receive" ("Đã quá giới hạn gửi đến người dùng này", the per-recipient limit is reached) | Permanent for this send: recipient quota. Do not retry automatically. |
| -219 | "App is removed or disabled" | Permanent, credentials. |
| -220 | "access_token is expired or removed" | Credentials. Same as -216, and also trigger a refresh. |
| -221 | "The OA needs to be verified to use this feature" | Permanent, credentials (tier). |
| -223 | "Official Account has not authorized this API" | Permanent, credentials (missing permission → re-authorise). The same code is also used for "Your OA has reach the limit quota create article" (article API), so **match on the message as well as the code**. |
| -224 | "The OA needs to upgrade OA Tier Package to use this feature" | Permanent, credentials (package expired). |
| -227 | "User is banned or has been inactive for more than 45 days" | Permanent: recipient. |
| **-230** | "User has not interacted with the OA in the past 7 days" | **Permanent, `reason='outside_window'`.** |
| **-232** | "User has not interacted with the OA, or the last interaction has expired" | **Permanent, `reason='outside_window'`.** |
| -233 | "message type is invalid or not support" | Permanent. |
| -234 | "This message cannot be sent at night (10:00PM - 7:00AM)" | Not expected for CS, which is 24/24. Treat as transient: delay to 07:00. |
| -235 | "This API does not support this type of OA" | Permanent, credentials (tier). |
| -240 | "MessageV2 API has been shut down, please switch to MessageV3" | Permanent: bug, wrong endpoint. |
| -242 | "Invalid appsecret_proof provided in the API argument" | Permanent, credentials (config). |
| -244 | "User has restricted this message type from your OA" | Permanent: recipient. |
| -248 | "Violates our platform standards" | Permanent. Alert an admin. |
| -320 | "Your app needs to connect with Zalo Cloud Account to use paid features" | Permanent: billing. Show "Liên kết ZCA với App". |
| -321 | "Zalo Cloud Account associated with this app is out of money or unable to be charged" | Permanent: billing. Show "Nạp tiền ZCA". |

- **[INFERENCE]** Errors arrive as HTTP 200 with `error ≠ 0` in the JSON body. HTTP 5xx or network failures are transient.
- **[INFERENCE]** Add a `PermanentSendReason` value `'billing'` for -211, -320 and -321, so the UI can explain it.

---

## 6. User profile [DOC]

Page: https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-nguoi-dung/truy-xuat-chi-tiet-nguoi-dung

```
GET https://openapi.zalo.me/v3.0/oa/user/detail?data={"user_id":"4572947693969771653"}
access_token: <token>
```

URL-encode the `data` JSON.

```json
{ "data": {
    "user_id": "4572947693969771653", "user_id_by_app": "4604138790644222978", "user_external_id": "",
    "display_name": "Tên hiển thị của người dùng", "user_alias": "Tên alias của người dùng",
    "is_sensitive": false, "user_last_interaction_date": "06/07/2023", "user_is_follower": false,
    "avatar": "https://s120-ava-talk.zadn.vn/…jpg",
    "avatars": { "120": "https://s120-ava-talk.zadn.vn/…", "240": "https://s240-ava-talk.zadn.vn/…" },
    "dynamic_param": "value",
    "tags_and_notes_info": { "notes": [""], "tag_names": [] },
    "shared_info": { "address": "123 Trần Hưng Đạo", "city": "Hồ Chí Minh", "district": "Quận 1", "phone": "84385953xxx", "name": "Tên người dùng" } },
  "error": 0, "message": "Success" }
```

- Permission: "Ứng dụng cần được cấp quyền quản lý thông tin người dùng" (the app needs user-management permission). In the console this sits under "Quyền: Quản lý thông tin OA → Lấy thông tin người dùng".
- `shared_info`: "Thuộc tính trả về thông tin người dùng đã chia sẻ cho OA. Nếu không có thông tin, data sẽ trả giá trị rỗng." (Info the user shared with the OA, e.g. via the info-request form; empty if none.) `phone` can be a **number** in one doc example and a string in another. Coerce it to a string.
- `is_sensitive: true` means the user is under 18. **[INFERENCE]** Flag it in the CRM. The AI should be careful.
- `user_last_interaction_date` is `dd/MM/yyyy` (date only). Use `quota/message` for the exact time.
- Works for any user who has interacted, follower or not. Changelog v240404: "API mới: truy xuất được thông tin người dùng có phát sinh tương tác với OA" (the new API returns users who have interacted with the OA).
- Avatars, changelog V260907 (https://developers.zalo.me/changelog/v260907-thong-bao-bo-sung-domain-avatar-7906):
  - new avatar domains such as `https://s120-26-ava-talk.zadn.vn/default?key=…&time=…`;
  - "Không nên cache URL này … URL Avatar không tồn tại vĩnh viễn" (do not cache the URL; avatar URLs do not live forever).
  - **[INFERENCE]** Download the avatar into our S3 on profile fetch, and refresh it occasionally.
- Name, avatar and `shared_info` fall under the Vietnam-IP rule (§8b).

---

## 7. Conversation history (backfill and incremental sync)

Both endpoints are still documented on the current docs site on 2026-11-05. They need "**Quyền quản lý tin nhắn người dùng**" and an OA package with API access (§1d).

### 7a. Recent messages across the OA [DOC]

https://developers.zalo.me/docs/official-account/tin-nhan/quan-ly-tin-nhan/lay-thong-tin-tin-nhan-gan-nhat

```
GET https://openapi.zalo.me/v2.0/oa/listrecentchat?data={"offset":0,"count":5}
access_token: <token>
```

- "API hỗ trợ lấy thông tin tối đa 10 tin nhắn gần nhất giữa OA và người dùng" (returns at most the 10 most recent messages between the OA and users).
- `offset`: "Tin nhắn gần nhất có thứ tự là 0" (the newest message is 0).
- `count`: "mỗi request được lấy tối đa 10 tin nhắn" (at most 10 per request).
- **[AMBIGUOUS]** The sentence "tối đa 10 tin nhắn gần nhất" can be read two ways:
  - an absolute cap: only the 10 newest messages across the whole OA can ever be read, and `offset ≥ 10` returns nothing;
  - a per-request cap of 10.

  The doc does not say whether deeper offsets work. **Do not build incremental sync on deep `listrecentchat` paging** until it is tested on a real OA (§7d).

### 7b. Messages with one user [DOC]

https://developers.zalo.me/docs/official-account/tin-nhan/quan-ly-tin-nhan/lay-thong-tin-tin-nhan-trong-mot-hoi-thoai

```
GET https://openapi.zalo.me/v2.0/oa/conversation?data={"user_id":2512523625412515,"offset":0,"count":5}
```

The doc's example passes `user_id` as a JSON number. **[INFERENCE]** Send it as a **string**: a number this large loses precision in JS. **[UNVERIFIED]** that the string form is accepted.

Response for both:

```json
{ "data": [ { "src": 1, "time": 1619401853770, "type": "text", "message": "Chào shop",
    "message_id": "92e5d851aa8178dd2192", "from_id": "2512523625412515", "to_id": "3120036654733951760",
    "from_display_name": "Khoa Pham", "from_avatar": "https://s240-ava-talk.zadn.vn/…",
    "to_display_name": "OA", "to_avatar": "https://s240-ava-talk.zadn.vn/…" } ],
  "error": 0, "message": "Success" }
```

- `src`: `0` means OA → user; `1` means user → OA.
- `time`: ms.
- `type`: `text`, `voice`, `photo`, `GIF`, `link`, `links`, `sticker`, `location`. **No `file` or `video` type is listed** **[AMBIGUOUS]**.
- Extra fields by type:
  - `links` (array);
  - `thumb` (photo or GIF);
  - `url` (voice, photo, GIF, sticker);
  - `description` (photo);
  - `location` ("longitude và latitude", a string).
- **No `since`/date filter and no cursor.** Page with `offset` += 10 until a message is older than the backfill window or the page is short.
- **[UNVERIFIED]** That history `message_id` equals the webhook `msg_id` and the `message_id` from `message/cs`. Verify it on the first sync. Dedupe depends on it.
- **[UNVERIFIED]** How far back the history goes, and whether OA-Manager staff messages appear with any marker. There is no `admin_id` or `app_id`, so we cannot tell our own sends from staff sends except by id match.

### 7c. Listing users to drive backfill [DOC]

https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-nguoi-dung/truy-xuat-danh-sach-nguoi-dung

```
GET https://openapi.zalo.me/v3.0/oa/user/getlist?data={"offset":0,"count":15,"last_interaction_period":"TODAY","is_follower":"true"}
```

- `count`: "tối đa 50 người dùng 1 request" (at most 50 users per request).
- `offset`: "Hỗ trợ tối đa 9951 (tương ứng 10000 người dùng)" (supports up to 9,951, i.e. 10,000 users).
- `last_interaction_period` (optional). Re-checked 2026-11-05: the earlier list here was **incomplete**. Full list:
  - `TODAY`;
  - `YESTERDAY`;
  - `L7D`: "7 ngày vừa qua, không bao gồm ngày hiện tại" (last 7 days, excluding today);
  - `L30D`: last 30 days, excluding today;
  - **a custom range `<YYYY_MM_DD:YYYY_MM_DD>`**, e.g. `2024_05_22:2024_05_23` ("trong khoảng thời gian tùy biến").
- `tag_name` (optional) filters by OA tag.
- `is_follower` (optional, boolean) filters by follow status. The doc's example passes the string `"true"`.
- Response: `{ "data": { "total", "count", "offset", "users": [ { "user_id": "…" } ] } }`. Ids only, so call `user/detail` per user for name and avatar.

### 7d. Sync policy [INFERENCE]

- **Backfill** (on connect or from the admin button):
  1. Call `user/getlist` with a **custom range** `last_interaction_period = "<today−ZALO_HISTORY_DAYS>:<today>"` in `YYYY_MM_DD` format (Vietnam date). If the custom range turns out to exclude today, also call `TODAY`. This replaces the earlier `L30D`/`L7D`/`TODAY` combination, which still works as a fallback. Omit `is_follower` so non-followers are included.
  2. For each user, call `v2.0/oa/conversation`, paging 10 at a time until older than `ZALO_HISTORY_DAYS` (default 30), capped at 200 messages.
  3. Each message costs one API call per 10 messages. Throttle under the OA limit: **Tăng trưởng = 100 req/phút**. For example, 1 request every 700 ms, leaving headroom for sends.
- **Incremental:**
  1. Every N minutes, page `listrecentchat` from offset 0 until reaching messages already stored. Because of the 10-message ambiguity in §7a, also run a cheaper fallback: `user/getlist` with `last_interaction_period=TODAY` (plus `YESTERDAY` just after midnight), then `conversation` for those users.
  2. Only for users whose newest message is unknown, fetch `conversation`.

  This is the safety net when the webhook was disabled (§4b) or the tunnel was down.
- Messages with `src=0` that do not match a stored `external_message_id` → import as `agent`, label "OA Manager / công cụ khác". Same rule as Messenger 13f.

---

## 8. Rate limits, IP rules, policy

### 8a. Rate limits [DOC]

Page: https://developers.zalo.me/docs/official-account/phu-luc/gioi-han-toc-do-api

- "Official Account API: **4.000 requests/phút**" per **app** (also Article 4,000; Social 4,000 and 20 per user per minute). The limit resets every minute. Exceeding it returns `-32`.
- "Giới hạn tốc độ gọi được tính trên Official Account theo từng loại gói OA" (there is also a per-OA limit by package). The pricing page gives **Tăng trưởng 100 req/phút**, Toàn diện 2,000 req/phút.
- Headers on every response:
  - `X-RateLimit-Limit`;
  - `X-RateLimit-Remain`: "khi số này bằng 0 có nghĩa là ứng dụng của bạn đã đạt tới giới hạn" (0 means the app has hit the limit).
- Upload APIs: 5,000 requests per month each (§5c).
- **[INFERENCE]** Use a Redis token bucket per OA at about 90 per minute on Tăng trưởng. Configure it with `ZALO_OA_RATE_PER_MIN`.

### 8b. IP rules [DOC]

Changelog v240229, https://developers.zalo.me/changelog/v240229-gioi-han-du-lieu-theo-dia-chi-ip-7667:

> "kể từ ngày 29/02/2024, hệ thống Zalo OpenAPI sẽ chỉ trả các dữ liệu liên quan người dùng, đến các Ứng dụng (app) và Webhook URL có **địa chỉ IP tại Việt Nam** … Các trường thông tin có thể bị ảnh hưởng: Hình đại diện của người dùng; Tên Zalo của người dùng; Các trường thông tin thuộc Mẫu xin thông tin người dùng: Số điện thoại, Tên, địa chỉ…; Các thông tin khác liên quan dữ liệu cá nhân người dùng. Các nhóm API/Webhook có thể bị ảnh hưởng: Zalo Official Account, Zalo Social, Webhook."
> (From 29/02/2024, Zalo OpenAPI returns user data only to apps and webhook URLs with Vietnamese IP addresses. Affected: user avatar, Zalo name, info-request form fields such as phone, name and address, and other personal data. Affected groups: Zalo OA, Zalo Social, webhooks.)

- **No IP whitelist** is documented for API callers.
- Domain verification asks you to "Bỏ chặn request từ các IP nước ngoài" (unblock foreign IPs) for the verifier crawler.
- **[INFERENCE] Production consequence:** the server that calls the API **and** the public webhook endpoint must have **Vietnamese IPs**. That means a Vietnamese VPS, and the webhook **not** behind a non-Vietnamese CDN or proxy. Cloudflare proxying (orange cloud) on `inbox.dezon.vn` may also blank fields in webhooks. Use DNS-only (grey cloud) for the webhook host, or check it in the console's webhook IP check. This **changes the Giai đoạn 1D VPS choice: Vietnam, not Singapore.**

### 8c. Policy [DOC]

- CS messages need a user interaction within 7 days (§5e). Following the OA is not required.
- "Hệ thống có cơ chế xác định và tự động hạn chế các luồng gửi tin có dấu hiệu gây phiền tới người dùng." (The system detects and automatically restricts sending patterns that look like spam.) Policy: https://oa.zalo.me/home/documents/policy/tuong-tac-cua-oa-voi-nguoi-dung. Error `-248` "Violates our platform standards".
- Anonymous users use separate v2 endpoints keyed by `anonymous_id` + `conversation_id` (§4d).
- "Tin Tư vấn" purpose: "Phản hồi khách hàng và hỗ trợ giải đáp về sản phẩm, dịch vụ khi khách hàng yêu cầu" (answer customers and support them about products and services when they ask). Our use case fits.
- TLS: TLS 1.1 and lower stopped being supported in 2022 (changelog v220701).

---

## 9. Docs vs official SDK differences

| Topic | Docs | SDK | Take |
|---|---|---|---|
| PKCE encoding | "Base64 (without Padding)" | base64**url**, no padding (PHP `PKCEUtil`, Java `PKCEUtil`) | Use base64url. Standard S256. |
| Code verifier | 43 characters, upper/lower/digits | Java: base64url of 32 random bytes; can contain `-` and `_` | Use 43 alphanumeric characters. |
| Webhook MAC | `sha256(appId + data + timeStamp + OAsecretKey)` | Java `MacUtils.buildMac` matches: plain SHA-256, lowercase hex. It uses the platform default charset. .NET `MacUtils.buildMac(string)` hashes **UTF-8** bytes with lowercase hex, so use UTF-8 / raw bytes. Neither is ever called, so the header format is unknown. The SDK doc page titles it "build X-Event-Signature". | Strip an optional `mac=` prefix. Read `x-zevent-signature`, falling back to `x-event-signature`. |
| Endpoints | v3.0 `message/cs`, v3.0 `user/detail`, v3.0 `user/getlist` | PHP SDK (last commit 2023-12-20) still has `v2.0/oa/message` (V2 send shut down: `-240`), `v2.0/oa/getprofile` and `v2.0/oa/getfollowers` (both deprecated 01/06/2024 per changelog v240404) | **Do not use the PHP SDK endpoint list.** Call the v3 endpoints directly. |
| appsecret_proof | Header `appsecret_proof = HMAC-SHA256(access_token, app_secret)` | PHP `Zalo.php`: same, sent as a header | Consistent. |
| Token request | Header `secret_key`, form body | PHP `OAuth2Client::sendRequest`: same, `https://oauth.zaloapp.com/v4/oa/access_token` | Consistent. |

---

## 10. Mapping to our connector interface [INFERENCE]

- **`verifyWebhook(req)`:**
  - compute §4c with `ZALO_APP_ID` and `ZALO_OA_SECRET_KEY`;
  - also require `body.app_id === ZALO_APP_ID`;
  - bad or missing signature → 401, nothing stored (spec 1B acceptance).
- **`parseWebhook`:**
  - `user_send_*` → `message`, `direction: 'in'`, `senderType: 'customer'`;
  - `oa_send_*` → `message`, `direction: 'out'`, classified by §4d;
  - `user_received_message` → `delivery`;
  - `user_seen_message` → `read`;
  - `follow`/`unfollow` → update contact or follower status (new event kind, or ignore in 1B);
  - `user_submit_info` → profile hint (phone/name/address);
  - `user_withdraw` → data deletion job;
  - `anonymous_*`, reactions, `user_click_chatnow` → log and ignore in 1B.
- **`send`:**
  - text → `message/cs`;
  - image → (re-encode to ≤ 1 MB jpg/png) `upload/image` → `message/cs` media template;
  - gif → `upload/gif` + `media_type: gif` with width/height;
  - pdf/doc/docx/csv ≤ 5 MB → `upload/file` → `message/cs` file;
  - anything else → `PermanentSendError`;
  - `externalMessageId = data.message_id`.
- **`fetchProfile`:** `user/detail` → `{ name: display_name, avatarUrl: avatars['240'] ?? avatar }`, plus `shared_info.phone` (extend the return type).
- **Token refresh job:**
  - Redis lock per channel account, then `SELECT … FOR UPDATE`, then re-check `expires_at`.
  - Call `grant_type=refresh_token`, then store both new tokens atomically.
  - Refresh when less than about 3 h remains of the 25 h. The refresh token is valid for 3 months, so a daily job is safe.
  - On failure, re-read the DB: another worker may have refreshed already. Otherwise set `status='expired'`.
- **Env:**
  - the spec has `ZALO_APP_ID`, `ZALO_APP_SECRET`, `ZALO_OA_SECRET_KEY`;
  - add `ZALO_HISTORY_DAYS`, `ZALO_OA_RATE_PER_MIN`, `ZALO_SITE_VERIFICATION_FILE` (dev).
- **Proposed public paths** (our code, not Zalo's; final names are up to the implementer):
  - webhook `POST /webhooks/zalo-oa`;
  - OAuth callback `GET /channels/zalo-oa/oauth/callback`;
  - verifier `GET /zalo_verifier<CODE>.html`, served at the root of the public URL.

---

## 11. Open items to verify on a real OA

1. The exact `X-ZEvent-Signature` value format (`mac=<hex>` or bare hex). Confirm the hash matches over the raw body and the body `timestamp`, including for Vietnamese diacritics. Is the body sent with `\uXXXX` escapes, or raw UTF-8?
2. Whether Zalo refuses to save a Webhook URL or OA Callback URL on an unverified `*.trycloudflare.com` host. Whether URL-prefix verification by HTML file works for that host.
3. Whether webhooks through Cloudflare lose personal fields. Check `user_submit_info` and the console's webhook IP check.
4. The OAuth callback query: is `state` echoed back? Any other parameters?
5. The token-endpoint error body (expired or reused refresh token, wrong verifier).
6. Whether `message_id` from `message/cs`, webhook `msg_id` and history `message_id` are the same id.
7. Whether our own API sends trigger `oa_send_*` to our webhook, with `app_id` equal to ours. The docs say yes.
8. The `user_send_business_card` payload, and the `user_send_video`/`user_send_audio` URL lifetime.
9. Behaviour on a non-Tăng-trưởng OA: which calls return `-224`.
10. `conversation` with `user_id` sent as a string.
11. Whether `listrecentchat` returns anything for `offset ≥ 10` (§7a), and whether it lists one row per conversation or raw messages.
12. Whether `user/getlist` with a custom `YYYY_MM_DD:YYYY_MM_DD` range includes today.
13. Which header name actually arrives: `X-ZEvent-Signature` (webhook pages) or `X-Event-Signature` (SDK doc heading).

---

## 11b. Kiểm chứng độc lập (2026-11-05)

A second agent re-opened every source below on 2026-11-05 and checked the claims against it. Method:

- static HTML from `stc-developers.zdn.vn/docs/v2/official-account/<path>/index.html`;
- changelog pages and `zalo.solutions/oa/pricing`, rendered in a headless browser;
- official screenshots `domain16.png`, `domain22.png`, `webhook_4.jpg` and `app_request_perm_oa_1.jpg`, viewed directly;
- the official SDK source (zip downloads of `zaloplatform/zalo-java-sdk`, `zalo-php-sdk` and `ZaloDotNetSDK`).

Verdicts:

- **CONFIRMED**: the source says exactly this.
- **CORRECTED**: the claim was wrong or incomplete; the text above has been fixed.
- **UNVERIFIABLE**: no official source settles it; test it on a real OA.

Short source keys used in the table (paths are under `developers.zalo.me/docs/official-account/` unless they are full URLs):

| Key | Page |
|---|---|
| OAuth | `bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new` |
| OAuth-codes | `phu-luc/cac-loai-ma-su-dung-trong-oauth` |
| WH-overview | `webhook/tong-quan` |
| WH-pages | the per-event pages under `webhook/tin-nhan/` and `webhook/quan-ly/` |
| Domain | `phu-luc/huong-dan-xac-thuc-domain` and its screenshots |
| Errors | `phu-luc/ma-loi` |
| Rate | `phu-luc/gioi-han-toc-do-api` |
| Msg-overview | `tin-nhan/tong-quan` |
| CS-text / CS-image / CS-file / CS-cond | `tin-nhan/tin-tu-van/gui-tin-tu-van-dang-van-ban`, `…-dinh-kem-anh`, `…-dinh-kem-file`, `…/dieu-kien-gui-tin-tu-van` |
| Upload | `tin-nhan/quan-ly-tin-nhan/upload-hinh-anh`, `…/upload-anh-gif`, `…/upload-file` |
| Quota | `tin-nhan/quan-ly-tin-nhan/kiem-tra-han-muc-gui-tin-nhan` |
| History | `tin-nhan/quan-ly-tin-nhan/lay-thong-tin-tin-nhan-gan-nhat`, `…/lay-thong-tin-tin-nhan-trong-mot-hoi-thoai` |
| User-detail / User-list | `quan-ly/quan-ly-thong-tin-nguoi-dung/truy-xuat-chi-tiet-nguoi-dung`, `…/truy-xuat-danh-sach-nguoi-dung` |
| Java-SDK-doc | https://developers.zalo.me/docs/sdk/java-sdk/tai-lieu/cac-ham-ma-hoa |
| .NET-SDK-doc | https://developers.zalo.me/docs/sdk/dotnet-sdk/tai-lieu/cac-ham-ma-hoa |

| # | Claim | Verdict | Source / note |
|---|---|---|---|
| 1 | Authorize URL `https://oauth.zaloapp.com/v4/oa/permission?app_id&redirect_uri&code_challenge&state` | CONFIRMED | Console screenshot `app_request_perm_oa_1.jpg`; PHP SDK `OAuth2Client::getAuthorizationUrlByOA` |
| 2 | PKCE: verifier 43 characters; challenge = SHA-256 of the ASCII verifier, Base64 without padding | CONFIRMED (doc) | OAuth, Bước 1 |
| 3 | The challenge encoding is **base64url** (`-_`), no padding | CONFIRMED (SDK) | Java and PHP `PKCEUtil`; Java-SDK-doc publishes the same code |
| 4 | No `code_challenge_method` parameter; S256 is implicit | CONFIRMED (absence) | OAuth, console form and SDK all omit it |
| 5 | Callback `GET <callback>?code=…&oa_id=…` | CONFIRMED | OAuth, Bước 3 |
| 6 | `state` is echoed on the callback | UNVERIFIABLE (SDK hint) | The doc example omits it; PHP `ZaloRedirectLoginHelper` reads `state` and `code_challenge`. The doc also allows a custom param inside `redirect_uri`. |
| 7 | Token endpoint `POST https://oauth.zaloapp.com/v4/oa/access_token`, `application/x-www-form-urlencoded`, header `secret_key: <App Secret>`; body `code, app_id, grant_type=authorization_code, code_verifier` (required if a challenge was set) | CONFIRMED | OAuth, Bước 4; PHP SDK `sendRequest` |
| 8 | Refresh body `refresh_token, app_id, grant_type=refresh_token` | CONFIRMED | OAuth |
| 9 | Response `{access_token, refresh_token, expires_in: "90000"}`; the attribute table misspells it `expire_in` | CONFIRMED | OAuth |
| 10 | Code valid 10 min, single use; access token 25 h; refresh token 3 months, single use; the old access token dies when a new one is issued | CONFIRMED | OAuth "Các thuật ngữ"; OAuth-codes |
| 11 | Error body of the token endpoint, and what a reused refresh token returns | UNVERIFIABLE | Not documented |
| 12 | appsecret_proof = HMAC-SHA256(access_token, app_secret) in an `appsecret_proof` header; optional unless enforced in Cài đặt | CONFIRMED | Changelog v240409; Java `AppSecretProofUtil` |
| 13 | Signature header `X-ZEvent-Signature`, `mac = sha256(appId + data + timeStamp + OAsecretKey)` | CONFIRMED (formula text) | Every WH-pages page. Java-SDK-doc heading says "X-Event-Signature" (inconsistent). |
| 14 | Plain SHA-256 (not HMAC), lowercase hex, UTF-8 | CONFIRMED (SDK) | Java `MacUtils` (default charset); .NET `MacUtils.buildMac` (`Encoding.UTF8`, `ToLower`) |
| 15 | `data` is the raw body string; `timeStamp` is the body's `timestamp` | UNVERIFIABLE | The doc says "data là chuỗi json trả về"; no source names the timestamp. Kept as [INFERENCE]. |
| 16 | The header value has a `mac=` prefix | UNVERIFIABLE | No official parser exists; no public community source was found either |
| 17 | 200 OK within 2 s; retries after 30 s/5 m/15 m/30 m/1 h with a `num_retry` header and identical content; the app is unsubscribed after persistent failure | CONFIRMED, with a nuance | WH-overview. Retries are documented **only for connection failures**; added to §4b. |
| 18 | Domain/URL verification is required before using URLs with Zalo Platform; DNS TXT/HTML/meta; URL prefix covers sub-paths; queries ignored | CONFIRMED | Domain; changelogs v211220/v211231. Added: file-extension paths are cut back to the directory. |
| 19 | Exempt tunnels: `localtunnel.me`, `ngrok.io`, `localhost.run`, `serveo.net`; trycloudflare is not on the list | CONFIRMED | Domain, "Chú ý" |
| 20 | 20 domains, 20 URLs, 75 characters max | CONFIRMED | Domain |
| 21 | Download `<CODE>.html`, serve it at `<prefix>/zalo_verifier<CODE>.html`; meta `zalo-platform-site-verification`; 512 KB; up to 72 h; unblock foreign IPs | CONFIRMED | Screenshots `domain22.png`, `domain16.png` |
| 22 | DNS TXT for `x.trycloudflare.com` is impossible (it checks `zalo_verifier.trycloudflare.com`) | CONFIRMED (derived) | Domain, DNS rule |
| 23 | Zalo rejects saving an unverified Webhook/Callback URL | UNVERIFIABLE | Only the general rule is stated. The "status bar links to /verify-domain" detail could not be seen in `webhook_4.jpg`. |
| 24 | A URL-prefix + HTML file on a quick-tunnel host is accepted | UNVERIFIABLE | Nothing forbids it; test it |
| 25 | Vietnam-IP rule for user data in API responses and webhooks; check the webhook IP in the console | CONFIRMED | Changelog v240229 (VI and EN text) |
| 26 | Webhook console fields (URL, OA Secret Key + Reset, Webhook Retry, Lọc cú pháp); event list includes `user_send_gif` | CONFIRMED | WH-overview; `webhook_4.jpg` |
| 27 | `user_send_*` envelope: `app_id`, `sender.id` (user), `recipient.id` (OA), `user_id_by_app`, `message.text`, `message.msg_id`, `attachments`, `quote_msg_id`, `timestamp` (string ms, the send time of the request) | CONFIRMED | `webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan`. The event table lists 9 `user_send_*` names; `user_send_gif` comes only from the console and the attachment shape. |
| 28 | Attachment payload shapes (image, gif, link, audio, video, sticker, location, file) | CONFIRMED | Same page |
| 29 | `oa_send_*` fires for Open API **and** OA Admin sends; `admin_id` only from the chat tool; six event names | CONFIRMED | `…/su-kien-official-account-gui-tin-nhan-cho-nguoi-dung` |
| 30 | `user_received_message` (`msg_id`) and `user_seen_message` (`msg_ids[]`), Mobile only; seen is sent only to the sending app; `sender` is the OA | CONFIRMED | Delivery and seen pages |
| 31 | follow/unfollow (`oa_id`, `follower.id`, `source`), `user_click_chatnow` (`oa_id`, `user_id`) | CONFIRMED | WH-pages |
| 32 | `user_withdraw` payload | CORRECTED (incomplete) | `oa_id` and `user_id` are `""` when the app is not linked; match on `user_id_by_app` too. Added to §4d. |
| 33 | `POST /v3.0/oa/message/cs`, header `access_token`, body `{recipient:{user_id}, message:{text}}`, text ≤ 2,000 characters | CONFIRMED | CS-text |
| 34 | Response `message_id`, `user_id`, `sent_time`, `quota{quota_type…}`; `remain` pinned to 8 from 1/1/2026 and dropped after 1/3/2026; no quota means charged | CONFIRMED | CS-text. Only `remain`/`total` are dropped; `quota_type` stays. |
| 35 | Image CS: `attachment.type=template`, `template_type=media`, one element, `media_type` image/gif, `attachment_id` **or** `url`, jpg/png ≤ 1 MB, gif needs width/height | CONFIRMED | CS-image |
| 36 | File CS: `attachment.type=file`, `payload.token` from `upload/file` | CONFIRMED | CS-file |
| 37 | Upload: `/v2.0/oa/upload/image` (jpg/png ≤ 1 MB, `attachment_id`), `/upload/gif` (≤ 5 MB; the table says `token`, the example `attachment_id`), `/upload/file` (PDF/DOC/DOCX/CSV ≤ 5 MB, `token`); 5,000/month; files kept 7 days | CONFIRMED | Upload pages (the GIF page contradicts itself on quota, as already noted) |
| 38 | Window: CS needs an interaction within 7 days; free within 48 h; paid after that; following not required; 24/24 | CONFIRMED | Msg-overview; CS-cond; Quota. Added GMF-chat and accept-call interactions. |
| 39 | `POST /v3.0/oa/quota/message {user_id}` returns `last_interaction` in ms | CONFIRMED | Quota |
| 40 | Legacy page "kiểm tra tin tư vấn trong khung 48h" (8 free messages) | CORRECTED (flagged stale) | That page contradicts the 2026 rule; added a note in §5e |
| 41 | Error codes -32 … -321 (messages) | CONFIRMED | Errors. Added -218; -204 means the OA was deleted; -223 is reused for the article quota. |
| 42 | `GET /v3.0/oa/user/detail?data={"user_id":"…"}` fields (`display_name`, `avatar(s)`, `user_is_follower`, `user_last_interaction_date` dd/MM/yyyy, `is_sensitive`, `shared_info`) | CONFIRMED | User-detail |
| 43 | `user/getlist`: `last_interaction_period` = TODAY/L7D/L30D only | CORRECTED | Also `YESTERDAY` and a custom `YYYY_MM_DD:YYYY_MM_DD` range; also `tag_name`. Fixed §7c/§7d. |
| 44 | `listrecentchat` / `conversation` endpoints, `src`, `time`, `type` list, `from_id`/`to_id` typed long but strings in the example; 10 per request | CONFIRMED | History |
| 45 | `listrecentchat` can be paged with `offset` beyond 10 | UNVERIFIABLE (flagged AMBIGUOUS) | "tối đa 10 tin nhắn gần nhất" may be an absolute cap. §7a/§7d now hedge this. |
| 46 | Rate limit 4,000 req/min per app for the OA API; per-OA limit by package; `X-RateLimit-Limit`/`X-RateLimit-Remain`; `-32` | CONFIRMED | Rate |
| 47 | Packages: Tăng trưởng 2.5M đ/year, Open API ✅, 100 req/min, 3 apps, 500 out-of-48 h CS per month; Toàn diện 6M đ, 2,000 req/min; 55 đ per message; FAQ "cần sử dụng Gói tăng trưởng hoặc toàn diện"; downgrade to Cơ bản on expiry | CONFIRMED | `zalo.solutions/oa/pricing` (via the `zalo.cloud` redirect). The FAQ now says "tài khoản ZBS" for billing; the error docs still say ZCA. |
| 48 | Avatar URLs must not be cached (V260907) | CONFIRMED | Changelog v260907 |
| 49 | ZCA linked to OA and App; one ZCA serves many; the admins can differ; integration itself is free | CONFIRMED | `bat-dau/kham-pha` |
| 50 | Permission groups (Gửi tin nhắn, Quản lý thông tin OA, Quản lý tin nhắn người dùng, Nhận sự kiện quản lý tin nhắn/người dùng) | CONFIRMED | `app_request_perm_oa_1.jpg`; OAuth Bước 2 list |

**Remaining uncertainties, in priority order for the local tunnel:**

1. Webhook signature value format: `mac=` prefix, timestamp source, and header name `X-ZEvent-Signature` vs `X-Event-Signature`.
2. Whether a URL-prefix verification of a quick-tunnel host is accepted, and whether unverified webhook or callback URLs are rejected.
3. Whether `state` is echoed on the callback.
4. Personal-data blanking for webhooks through Cloudflare's non-Vietnamese edge.
5. `listrecentchat` paging depth.
6. Whether the three message-id kinds are equal.

All of these need one live test session on a real OA (§11).

---

## 12. Việc chủ sản phẩm cần làm trên Zalo

> Làm theo thứ tự. Bước nào cần trả tiền hoặc cần giấy tờ thì làm sớm vì có thể mất vài ngày.

### A. Chuẩn bị OA (trên https://oa.zalo.me)

1. **Xác thực OA** (nếu OA chưa có dấu tích vàng). Vào https://oa.zalo.me/manage/cert, nộp hồ sơ doanh nghiệp. API chỉ dùng được với **OA đã xác thực**.
2. **Mua gói "Tăng trưởng"** (2.500.000 đ/năm) hoặc "Toàn diện" (6.000.000 đ/năm) tại https://oa.zalo.me/manage/subscription. Bảng giá: https://zalo.solutions/oa/pricing.
   - Zalo ghi rõ: *"Để liên kết ứng dụng với OA thông qua API, bạn cần sử dụng Gói tăng trưởng hoặc toàn diện."*
   - Gói Tăng trưởng cho phép 3 ứng dụng liên kết, giới hạn 100 lệnh gọi API mỗi phút, có 500 tin tư vấn ngoài khung 48 giờ mỗi tháng.
   - Nên **bật tự động gia hạn**. Nếu gói hết hạn, OA về gói Cơ bản và hệ thống sẽ mất kết nối.
3. **Tạo Zalo Cloud Account (ZCA)** và nạp một ít tiền.
   - Hướng dẫn tạo: https://oa.zalo.me/home/resources/guides/huong-dan-tao-zalo-cloud-account_75
   - Liên kết ZCA với OA: https://oa.zalo.me/home/resources/guides/quan-ly-lien-ket-tai-khoan-zca-tren-oa-manager_2369658111223417641
   - Cần ZCA để gửi tin tư vấn **sau 48 giờ** (55 đ/tin khi hết hạn mức có sẵn của gói). Không có ZCA thì các tin này bị lỗi.

### B. Tạo ứng dụng trên https://developers.zalo.me

4. Đăng nhập bằng tài khoản Zalo của người sẽ quản trị ứng dụng (nên là tài khoản công ty, không phải tài khoản cá nhân của một nhân viên dễ nghỉ việc). Bấm **Tạo ứng dụng** (https://developers.zalo.me/createapp).
5. Mục **Cài đặt** điền đủ: **Tên hiển thị** (ví dụ "Dezon Inbox"), **Điện thoại liên hệ**, **Email liên hệ**, **Danh mục**, **Mô tả**. Bấm **Lưu thay đổi**. Sau đó gạt công tắc góc phải từ **"Chưa kích hoạt"** sang **"Đang hoạt động"**.
6. Mục **Đăng ký sử dụng API** → bật **Official Account API**.
7. **Liên kết ZCA với ứng dụng** (khác với bước liên kết ZCA với OA): https://oa.zalo.me/home/resources/guides/huong-dan-lien-ket-app-id-vao-tai-khoan-zalo-cloud-account_6782655752710538229

### C. Xác thực domain (bắt buộc trước khi dán URL)

8. Mục **Xác thực domain**:
   - **Khi chạy thử trên máy (local):** tôi sẽ gửi bạn địa chỉ tạm dạng `https://<chuỗi-ngẫu-nhiên>.trycloudflare.com/`.
     - Dán vào ô **"Tiền tố URL"** → **Xác thực** → chọn **"Tải tệp HTML lên trang web của bạn"** → **tải tệp `.html` về và gửi cho tôi**.
     - Tôi cho hệ thống trả tệp đó ở địa chỉ `https://<...>.trycloudflare.com/zalo_verifier<mã>.html`.
     - Sau đó bạn bấm **Xác thực**.
     - ⚠️ Địa chỉ trycloudflare **đổi mỗi lần tôi khởi động lại đường hầm**, nên bước này và bước 10–11 phải làm lại. Một ứng dụng chỉ giữ tối đa 20 URL, nên xóa URL cũ.
     - Đỡ phiền hơn: tạo một tên miền con cố định, ví dụ `zalo-dev.dezon.vn`, cho môi trường thử. Bạn cần quyền sửa DNS của dezon.vn.
   - **Khi chạy thật (Giai đoạn 1D):** xác thực **Domain** `dezon.vn` (hoặc `inbox.dezon.vn`) bằng cách **thêm bản ghi DNS TXT** theo mã Zalo đưa. Bạn hoặc người quản lý tên miền thêm bản ghi, rồi bấm **Xác thực**.
   - ⚠️ **Máy chủ thật phải đặt ở Việt Nam** (không dùng Singapore). Zalo chỉ trả tên, ảnh đại diện và số điện thoại khách cho máy chủ và webhook có **IP Việt Nam**. Nếu dùng Cloudflare cho `inbox.dezon.vn` thì để chế độ **DNS only (đám mây xám)** cho địa chỉ webhook.

### D. Cấu hình kết nối OA và webhook

9. Mục **Official Account → Thiết lập chung**:
   - Ô **"Official Account Callback Url"**: dán địa chỉ tôi gửi, dạng `https://<địa-chỉ-công-khai>/channels/zalo-oa/oauth/callback` → bấm **Cập nhật/Lưu**.
   - Ô **Code Challenge** và **State**: **để trống**. Hệ thống tự tạo mỗi lần kết nối.
   - Phần **"Chọn quyền cần yêu cầu được cấp từ OA"** chỉ tích các quyền sau:
     - **Quyền: Gửi tin nhắn**
     - **Quyền: Quản lý thông tin OA** (để lấy tên, ảnh, số điện thoại khách)
     - **Quyền: Quản lý tin nhắn người dùng** (để đồng bộ lịch sử chat)
     - **Quyền: Nhận sự kiện quản lý tin nhắn**
     - **Quyền: Nhận sự kiện quản lý người dùng**
     - Các quyền khác (ZNS, bài viết, cửa hàng, ads, gọi thoại, nhóm GMF, mua sản phẩm…) **bỏ tích**.
   - Bấm **Lưu**.
10. Mục **Webhook**:
    - **Webhook URL** → bấm **Thay đổi** → dán `https://<địa-chỉ-công-khai>/webhooks/zalo-oa` → lưu. Hệ thống của tôi phải đang chạy lúc bạn bấm lưu.
    - **Webhook Retry**: **bật**.
    - **Lọc cú pháp**: **TẮT**. Nếu bật, hệ thống chỉ nhận tin bắt đầu bằng dấu "#".
    - Bấm vào biểu tượng con mắt ở ô **OA Secret Key** để xem mã. **Không bấm Reset** (bấm sẽ làm hỏng xác thực webhook cho tới khi tôi cập nhật mã mới).
11. Trong **"Danh sách sự kiện webhook"**, **bật** các sự kiện sau:
    - Khách gửi tin: `user_send_text`, `user_send_image`, `user_send_gif`, `user_send_file`, `user_send_sticker`, `user_send_link`, `user_send_location`, `user_send_audio`, `user_send_video`, `user_send_business_card`
    - OA gửi tin (kể cả nhân viên trả lời trong OA Manager): `oa_send_text`, `oa_send_image`, `oa_send_gif`, `oa_send_file`, `oa_send_sticker`, `oa_send_list`
    - Đã nhận, đã xem: `user_received_message`, `user_seen_message`
    - Người dùng: `follow`, `unfollow`, `user_submit_info`, `user_withdraw` (khách yêu cầu xóa dữ liệu)

    Có thể bấm **Test** từng sự kiện để thử khi hệ thống của tôi đang chạy.

### E. Gửi lại cho tôi (qua kênh riêng tư, không gửi trong nhóm chat chung)

| Thông tin | Lấy ở đâu | Biến môi trường |
|---|---|---|
| **App ID** (ID ứng dụng) | Ứng dụng → Cài đặt | `ZALO_APP_ID` |
| **Khóa bí mật của ứng dụng** (App Secret Key) | Ứng dụng → Cài đặt → biểu tượng con mắt hoặc copy | `ZALO_APP_SECRET` |
| **OA Secret Key** | Ứng dụng → Webhook → ô OA Secret Key | `ZALO_OA_SECRET_KEY` |
| **OA ID** và tên OA | https://oa.zalo.me/manage/oa (hoặc tôi tự lấy sau khi kết nối) | để đối chiếu |
| Tệp `zalo_verifier….html` (khi dùng địa chỉ thử) | Xác thực domain → Tiền tố URL → Tải tệp HTML | `ZALO_SITE_VERIFICATION_FILE` |
| Gói OA đang dùng và ngày hết hạn | https://oa.zalo.me/manage/subscription | để cảnh báo trước khi hết hạn |

### F. Kết nối OA vào hệ thống (sau khi tôi làm xong phần code)

12. Người là **quản trị viên OA** đăng nhập trang admin Dezon Inbox → **Kênh → Kết nối Zalo OA**. Trang Zalo hiện ra → chọn đúng OA → bấm **"Cho phép"**. Trạng thái kênh chuyển sang **connected**.
13. Thử: dùng một tài khoản Zalo cá nhân nhắn tin vào OA. Tin phải hiện trong hộp thư. Trả lời từ hộp thư, cả chữ lẫn ảnh, phải tới điện thoại.
14. Lưu ý vận hành:
    - Trong **48 giờ** kể từ lần cuối khách tương tác thì gửi miễn phí, không giới hạn số tin.
    - Từ **48 giờ đến 7 ngày** thì có phí: trừ vào 500 tin của gói, sau đó 55 đ/tin từ ZCA.
    - **Quá 7 ngày** thì không gửi được nữa.
    - Ảnh gửi đi tối đa 1 MB (hệ thống tự nén).
    - Tệp đính kèm chỉ nhận **PDF, DOC, DOCX, CSV** dưới 5 MB. Không gửi được video hay file Excel qua Zalo OA.

---

Sources (all accessed 2026-11-05):

- https://developers.zalo.me/docs/official-account/bat-dau/kham-pha
- https://developers.zalo.me/docs/official-account/bat-dau/khoi-tao-ung-dung
- https://developers.zalo.me/docs/official-account/bat-dau/xac-thuc-va-uy-quyen-cho-ung-dung-new
- https://developers.zalo.me/docs/official-account/bat-dau/gioi-thieu-official-account-api-va-cac-nhom-quyen
- https://developers.zalo.me/docs/official-account/phu-luc/cac-loai-ma-su-dung-trong-oauth
- https://developers.zalo.me/docs/official-account/phu-luc/huong-dan-lay-khoa-bi-mat-cua-ung-dung
- https://developers.zalo.me/docs/official-account/phu-luc/huong-dan-xac-thuc-domain
- https://developers.zalo.me/docs/official-account/phu-luc/ma-loi
- https://developers.zalo.me/docs/official-account/phu-luc/gioi-han-toc-do-api
- https://developers.zalo.me/docs/official-account/phu-luc/cac-tuong-tac-cua-nguoi-dung-voi-oa
- https://developers.zalo.me/docs/official-account/webhook/tong-quan and every page under `/webhook/tin-nhan/` and `/webhook/quan-ly/` cited above
- https://developers.zalo.me/docs/official-account/tin-nhan/tong-quan
- https://developers.zalo.me/docs/official-account/tin-nhan/tin-tu-van/dieu-kien-gui-tin-tu-van, …/gui-tin-tu-van-dang-van-ban, …/gui-tin-tu-van-dinh-kem-anh, …/gui-tin-tu-van-dinh-kem-file
- https://developers.zalo.me/docs/official-account/tin-nhan/quan-ly-tin-nhan/upload-hinh-anh, …/upload-anh-gif, …/upload-file, …/kiem-tra-han-muc-gui-tin-nhan, …/kiem-tra-tin-tu-van-trong-khung-48h, …/lay-thong-tin-tin-nhan-gan-nhat, …/lay-thong-tin-tin-nhan-trong-mot-hoi-thoai
- https://developers.zalo.me/docs/official-account/tin-nhan/cac-loai-tin-khac/gui-tin-nhan-van-ban-den-nguoi-dung-an-danh
- https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-nguoi-dung/truy-xuat-chi-tiet-nguoi-dung, …/truy-xuat-danh-sach-nguoi-dung
- https://developers.zalo.me/docs/official-account/quan-ly/quan-ly-thong-tin-oa/lay-thong-tin-zalo-official-account, …/kiem-tra-han-muc-tin-nhan-oa
- Changelog: https://developers.zalo.me/changelog (entries v260310/V260306, V260907, v240409, v240404, v240229, v231031, v220522, v211231, v211220)
- https://zalo.solutions/oa/pricing (redirect target of https://zalo.cloud/oa/pricing)
- https://github.com/zaloplatform/zalo-php-sdk (`src/Authentication/OAuth2Client.php`, `src/Util/PKCEUtil.php`, `src/Zalo.php`, `src/ZaloEndPoint.php`)
- https://github.com/zaloplatform/zalo-java-sdk (`utils/MacUtils.java`, `utils/PKCEUtil.java`, `utils/AppSecretProofUtil.java`)
- https://github.com/zaloplatform/ZaloDotNetSDK (`src/sdk/utils/MacUtils.cs`), added in the 2026-11-05 verification
- https://developers.zalo.me/docs/sdk/java-sdk/tai-lieu/cac-ham-ma-hoa and https://developers.zalo.me/docs/sdk/dotnet-sdk/tai-lieu/cac-ham-ma-hoa (official SDK doc pages: "build X-Event-Signature", PKCE, appsecret_proof), added in the 2026-11-05 verification
- PHP SDK `src/Authentication/ZaloRedirectLoginHelper.php` (callback params `code`, `state`, `code_challenge`), added in the 2026-11-05 verification
