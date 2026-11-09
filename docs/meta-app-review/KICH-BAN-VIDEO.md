# Kịch bản quay video cho App Review

App: **Dezon Inbox** (App ID `1727184952398550`). Soạn ngày 2026-11-05, dựa trên `docs/meta-app-review/research.md`.
Dùng cùng `QUYEN-VA-MO-TA.md`: mỗi quyền trong file đó ghi "Video: cảnh số ...", tương ứng với các cảnh dưới đây.

## Meta yêu cầu gì ở video

Theo hướng dẫn chính thức của Meta:

- **Mỗi quyền xin phải có video** cho thấy cách dùng quyền đó. Thiếu video cho quyền nào thì quyền đó bị từ chối.
- **Quay cả quá trình đăng nhập**, bắt đầu từ trạng thái **đã đăng xuất**.
- **Thấy rõ hộp thoại Facebook** lúc người dùng bấm nút đăng nhập Facebook và **cấp quyền** cho app.
- **Thấy dữ liệu được dùng vào việc gì**: tin khách về hệ thống, tên và ảnh khách hiện ra, câu trả lời tới tay khách.
- Với `pages_messaging`: phải quay **cảnh tin được gửi từ app** và **Messenger nhận và hiển thị tin đó**. Ảnh chụp màn hình tin nhắn không được chấp nhận.
- **Giao diện tiếng Anh, hoặc có chú thích tiếng Anh.** Dezon Inbox chỉ có tiếng Việt, nên **mỗi bước phải có chú thích tiếng Anh** giải thích đang làm gì và nút tiếng Việt nghĩa là gì. Các chú thích có sẵn trong bảng bên dưới, chỉ cần chép.
- **Không cần tiếng.** Meta không nghe. Tắt micro.
- Quay độ phân giải cao (1080p trở lên). Meta khuyên **đặt màn hình rộng tối đa 1440 điểm ảnh** cho chữ to, dễ đọc. Có thể phóng to (zoom) và chỉ chuột vào chỗ quan trọng.
- **[CHƯA XÁC MINH]** Meta không ghi độ dài tối đa hay định dạng tệp. Gợi ý: mỗi video **2–5 phút**, tệp **MP4**.

---

## Phần 1: Chuẩn bị (làm trước ngày quay)

### 1.1 Tài khoản và Trang

| Cần có | Ghi chú |
| --- | --- |
| Hệ thống chạy trên địa chỉ HTTPS công khai | [ĐIỀN: ví dụ https://inbox.dezon.vn]. Quay trên đúng địa chỉ sẽ gửi cho Meta, không quay trên máy phát triển (localhost) |
| Tài khoản Dezon Inbox vai trò **Quản trị viên** | Dùng để quay. Có thể dùng luôn tài khoản người duyệt: [ĐIỀN: email, ví dụ meta-review@dezon.vn] |
| Tài khoản Facebook **quản trị Trang thử** | Người bấm "Kết nối → Facebook". Phải là người thật, có vai trò trong app |
| Tài khoản Facebook **đóng vai khách** | Một người thật, đã được thêm làm **Người dùng thử** trong **Vai trò trong ứng dụng** và **đã bấm chấp nhận lời mời** (người đó vào developers.facebook.com/requests để chấp nhận). Ở chế độ Phát triển, chỉ tin của người có vai trò mới về hệ thống. **Không dùng tài khoản giả** |
| Trang thử | [ĐIỀN: tên Trang, ví dụ "Demo app"], **đã xuất bản**, không chứa thông tin nhạy cảm |

**Để quay được cảnh kết nối Trang thật (cảnh 2–4)**, Trang thử phải **chưa kết nối** lúc bắt đầu quay. Chọn một trong hai cách:

- Tạo thêm một Trang thử mới, chưa từng kết nối. Cách này sạch nhất.
- Hoặc trước khi quay, vào **Quản trị → Kênh**, ngắt kết nối Trang thử. Hỏi đội kỹ thuật trước để chắc việc ngắt rồi kết nối lại không làm mất dữ liệu cần giữ.

### 1.2 Chuẩn bị riêng cho cảnh Human Agent (cảnh 10, chỉ khi xin Human Agent)

- **2–3 ngày trước ngày quay:** người đóng vai khách nhắn một tin vào Trang thử, ví dụ "Can you send me a quote for a living room design?".
- **Từ đó tới lúc quay, người đóng vai khách không nhắn thêm gì** vào Trang. Tin cuối của khách phải cũ hơn 24 giờ và chưa quá 7 ngày.
- Nhờ đội kỹ thuật **bật `META_HUMAN_AGENT_ENABLED=true`** trước khi quay cảnh này.

### 1.3 Máy tính

1. **Độ phân giải màn hình:** Cài đặt → Hệ thống → Màn hình → Độ phân giải màn hình → chọn **1440 × 900** (hoặc độ rộng nhỏ hơn 1440 gần nhất). Nhớ đổi lại sau khi quay.
2. **Con trỏ chuột to hơn:** Cài đặt → Trợ năng → Con trỏ chuột và cảm ứng → kéo kích thước lên khoảng 2–3.
3. **Tắt thông báo:** bật chế độ **Không làm phiền** của Windows. Tắt Zalo, Messenger trên máy, email.
4. **Đổi ngôn ngữ Facebook sang tiếng Anh** cho cả hai tài khoản Facebook (quản trị Trang và đóng vai khách): Facebook → Cài đặt → Ngôn ngữ và khu vực → English (US). Hộp thoại đăng nhập Facebook và Messenger sẽ hiện tiếng Anh, đỡ phải thêm chú thích.
5. **Hai trình duyệt riêng:**
   - **Trình duyệt A** (ví dụ Chrome): mở Dezon Inbox. **Đăng xuất Dezon Inbox** và **đăng xuất Facebook** trong trình duyệt này, để quay được cả bước đăng nhập.
   - **Trình duyệt B** (ví dụ Edge): mở **messenger.com**, đăng nhập bằng tài khoản đóng vai khách.
   - Ẩn thanh dấu trang, đóng các tab khác, không để lộ email, mật khẩu hay tin nhắn riêng.
6. **Xếp đôi màn hình** cho cảnh 5–8 và 10: kéo cửa sổ A sang trái (phím Windows + ←), cửa sổ B sang phải (phím Windows + →). Kéo vạch giữa sao cho Dezon Inbox chiếm khoảng 2/3 màn hình. Nếu Dezon Inbox hiện dạng một cột như trên điện thoại thì vẫn được, miễn thấy rõ tin.

   Meta chấp nhận Messenger bản web hoặc bản điện thoại. Dùng messenger.com trên máy tính là dễ nhất, không cần chiếu màn hình điện thoại.
7. **Phần AI phải đang tắt** (`FEATURE_AI_ENABLED=false`, đang là mặc định). Video không được có phần AI vì lần này không xin quyền cho AI.

### 1.4 Công cụ

- **Quay:** công cụ **Snipping Tool** có sẵn trong Windows 11. Bấm **Windows + Shift + R**, khoanh vùng toàn màn hình, bấm **Bắt đầu**. Tệp lưu dạng MP4.
- **Thêm chú thích và cắt ghép:** **Clipchamp** (có sẵn trong Windows 11, miễn phí). Thêm chữ bằng mục **Văn bản**, che chỗ nhạy cảm bằng **hình khối** màu, xuất video **1080p**.

### 1.5 Dữ liệu nhạy cảm

- Khi đăng nhập xong, Hộp thư sẽ hiện **hội thoại của mọi Trang**, gồm cả khách thật. Ngay sau khi đăng nhập, bấm chip lọc **[ĐIỀN: tên Trang thử]** ở đầu danh sách để chỉ còn hội thoại của Trang thử.
- Vài giây hội thoại thật lộ ra trước khi bấm lọc: lúc dựng video, **che bằng hình khối** trong Clipchamp.
- Mật khẩu gõ vào ô đã tự hiện dấu chấm. Nếu Facebook hỏi mã xác thực hai bước, cắt đoạn đó ra.
- Không quay số điện thoại, email cá nhân, mã số thuế hay giấy tờ.

---

## Phần 2: Kịch bản từng cảnh

Cách đọc bảng:

- **Thao tác:** việc anh/chị làm trên màn hình.
- **Chú thích tiếng Anh:** chữ cần thêm lên video bằng Clipchamp, chép nguyên văn. Đặt ở cạnh dưới hoặc cạnh trên, chữ trắng trên nền tối cho dễ đọc. Để mỗi chú thích ít nhất 3–4 giây.
- Thời lượng chỉ là gợi ý.

Quay theo thứ tự. Cảnh 1–9 quay **một lèo** thành một video gốc. Cảnh 10 và 12 quay riêng.

### Cảnh 0: Màn hình mở đầu (thêm khi dựng, không cần quay)

| Thao tác | Chú thích tiếng Anh |
| --- | --- |
| Trong Clipchamp, thêm một khung chữ 4–5 giây ở đầu video | `Dezon Inbox - internal customer support inbox for Dezon's own Facebook Pages. Used only by Dezon employees.` |
| | `The app interface is in Vietnamese. English captions explain each step and each button.` |

### Cảnh 1: Đăng nhập Dezon Inbox (khoảng 20 giây)

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 1.1 | Trình duyệt A, toàn màn hình. Mở [ĐIỀN: địa chỉ hệ thống]. Hiện trang **Đăng nhập** (đang đăng xuất) | `Starting logged out. This is the Dezon Inbox login page ("Đăng nhập" = Log in).` |
| 1.2 | Gõ email vào ô **Email**, mật khẩu vào ô **Mật khẩu**, bấm **Đăng nhập** | `A Dezon staff member logs in with their company email and password ("Mật khẩu" = Password).` |
| 1.3 | Vào **Hộp thư**. Bấm ngay chip lọc **[ĐIỀN: tên Trang thử]** | `This is the shared inbox ("Hộp thư"). We filter the list to our test Page.` |

### Cảnh 2: Mở trang Kênh và bấm Kết nối Facebook (khoảng 15 giây)

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 2.1 | Bấm **Quản trị** trên thanh trên cùng. Trang **Kênh** mở ra | `The admin opens Admin > Channels ("Quản trị" = Admin, "Kênh" = Channels) to connect a Facebook Page.` |
| 2.2 | Rê chuột vào nút **Kết nối**, bấm. Menu hiện **Facebook** và **Dán Page Access Token**. Bấm **Facebook** | `Click "Kết nối" (Connect), then "Facebook". This starts Facebook Login for Business.` |

### Cảnh 3: Hộp thoại Facebook Login for Business, cấp quyền (khoảng 40 giây)

**Cảnh quan trọng nhất cho các quyền về Trang.** Đi chậm, dừng 2–3 giây ở mỗi màn hình của Facebook để thấy rõ chữ.

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 3.1 | Trang đăng nhập Facebook hiện ra. Đăng nhập bằng tài khoản quản trị Trang thử | `Facebook Login for Business opens. The admin logs in with the Facebook account that manages Dezon's Pages.` |
| 3.2 | Facebook hiện màn hình tiếp tục với tên app **Dezon Inbox**. Bấm tiếp | `The admin continues as themselves to Dezon Inbox.` |
| 3.3 | Màn hình chọn Trang: tick **[ĐIỀN: tên Trang thử]** | `The admin chooses which Pages Dezon Inbox can access.` |
| 3.4 | Màn hình liệt kê quyền app xin. **Dừng lâu**, phóng to (zoom) khi dựng | `Permissions requested: show the list of Pages (pages_show_list), manage Page metadata / webhooks (pages_manage_metadata), manage Page messages (pages_messaging) and read Page conversations (pages_read_engagement).` |
| 3.5 | Bấm nút đồng ý / lưu (Save, Continue) | `The admin grants the permissions.` |
| 3.6 | Màn hình báo đã liên kết. Bấm **Got it** / **OK**. Facebook đưa về Dezon Inbox | `Facebook returns the admin to Dezon Inbox.` |

> Danh sách quyền trên màn hình Facebook phụ thuộc vào cấu hình đăng nhập của app. Nếu màn hình **không có** `pages_read_engagement`, sửa chú thích 3.4 theo đúng những gì hiện ra. Báo đội kỹ thuật thêm quyền này vào cấu hình đăng nhập trước khi quay lại.

### Cảnh 4: Chọn Trang để kết nối, Trang hiện "Đã kết nối" (khoảng 20 giây)

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 4.1 | Hộp thoại **Chọn Trang để kết nối** hiện danh sách Trang của tài khoản Facebook | `Dezon Inbox lists the Pages this admin manages (pages_show_list). "Chọn Trang để kết nối" = Select Pages to connect.` |
| 4.2 | Tick Trang thử, bấm **Kết nối (1)** | `The admin selects the test Page and clicks "Kết nối" (Connect).` |
| 4.3 | Trang hiện trong danh sách kênh với nhãn **Đã kết nối**, nằm dưới tên tài khoản Facebook vừa đăng nhập. Chỉ chuột vào | `The Page is connected ("Đã kết nối" = Connected). Dezon Inbox automatically subscribes the Page to our Messenger webhook (pages_manage_metadata), so new messages arrive in real time.` |

### Cảnh 5: Chuyển sang chia đôi màn hình (khoảng 10 giây)

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 5.1 | Bấm **Hộp thư** để quay về hộp thư, chip lọc Trang thử vẫn bật. Xếp trình duyệt A bên trái, trình duyệt B (messenger.com của người đóng vai khách) bên phải | `Left: Dezon Inbox (staff). Right: Messenger on the web, logged in as a customer test account (an app tester).` |

### Cảnh 6: Khách nhắn vào Trang trong Messenger (khoảng 15 giây)

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 6.1 | Bên phải: mở hội thoại với Trang thử (hoặc vào m.me/[ĐIỀN: tên trang]). Gõ `Hello, I would like a quote for a living room design.` rồi gửi | `The customer sends a message to Dezon's Page in Messenger.` |

### Cảnh 7: Tin về Dezon Inbox kèm tên và ảnh khách (khoảng 25 giây)

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 7.1 | Bên trái: hội thoại mới hiện ở đầu danh sách, có tên và ảnh khách. **Không bấm gì**, chờ cho thấy tin tự hiện | `Within seconds the message appears in Dezon Inbox, received through the Messenger webhook (pages_messaging).` |
| 7.2 | Bấm mở hội thoại. Bấm nút **Thông tin khách** (biểu tượng chữ i) để mở cột bên phải. Khi dựng, phóng to vào tên và ảnh | `The customer's name and profile picture are shown in the list, the conversation header and the customer panel (Business Asset User Profile Access). "Thông tin khách" = Customer details.` |

### Cảnh 8: Nhân viên trả lời, khách nhận trên Messenger (khoảng 30 giây)

**Cảnh quan trọng nhất cho `pages_messaging`.** Phải thấy cả hai bên trong cùng một khung hình.

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 8.1 | Bên trái: gõ vào ô **Nội dung tin nhắn** ở dưới cùng: `Hi! Thank you for contacting Dezon. Could you share the room size?` | `A Dezon staff member types a reply ("Nội dung tin nhắn" = Message).` |
| 8.2 | Bấm nút **Gửi** (hoặc Enter) | `Click "Gửi" (Send). Dezon Inbox sends the reply through the Send API (pages_messaging).` |
| 8.3 | Bên phải: tin trả lời hiện trong Messenger của khách. Chỉ chuột vào | `The customer receives the reply in Messenger.` |
| 8.4 | Bên phải: khách đọc tin (để cửa sổ Messenger mở là được). Bên trái: dưới tin trả lời, trạng thái đổi **Đã gửi → Đã nhận → Đã xem** | `Status under the message: "Đã gửi" = Sent, "Đã nhận" = Delivered, "Đã xem" = Seen.` |
| 8.5 | (Nên có) Bên trái: bấm nút đính kèm, chọn một ảnh mẫu thiết kế, gửi. Bên phải: ảnh hiện trong Messenger | `Staff can also send images and files to answer the customer.` |

### Cảnh 9: Đồng bộ lịch sử (khoảng 30 giây, cho `pages_read_engagement`)

Trước khi quay, Trang thử nên có sẵn vài hội thoại cũ (người đóng vai khách hoặc nhân viên khác đã nhắn từ trước).

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 9.1 | Đưa trình duyệt A về toàn màn hình. Vào **Quản trị → Kênh** | `Admin > Channels again.` |
| 9.2 | Ở dòng Trang thử, bấm **Đồng bộ lịch sử**. Chọn **Khoảng thời gian** (ví dụ 30 ngày), bấm **Đồng bộ** | `"Đồng bộ lịch sử" = Sync history. Dezon Inbox reads the Page's recent Messenger conversations through the Conversations API (pages_read_engagement + pages_messaging).` |
| 9.3 | Chờ hết dòng "Đang đồng bộ lịch sử…" (cắt bớt thời gian chờ khi dựng). Quay về **Hộp thư**, chip lọc Trang thử | `"Đang đồng bộ lịch sử" = Syncing history.` |
| 9.4 | Mở một hội thoại cũ, cuộn lên thấy tin trước ngày kết nối | `Earlier conversations now appear in the inbox, so staff can see the full context before replying.` |

### Cảnh 10: Human Agent, trả lời sau 24 giờ (quay riêng, chỉ khi xin Human Agent)

Dùng hội thoại đã chuẩn bị ở mục 1.2. Xếp đôi màn hình như cảnh 5. Quay lại cả bước đăng nhập (cảnh 1) ở đầu video này.

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 10.1 | Bên trái: mở hội thoại. Chỉ chuột vào thời gian tin cuối của khách (hơn 24 giờ trước) | `The customer's last message was sent more than 24 hours ago (standard messaging window has closed).` |
| 10.2 | Rê chuột vào huy hiệu **HUMAN_AGENT** ở đầu khung chat cho hiện dòng giải thích. Phóng to khi dựng | `The header shows a HUMAN_AGENT badge. Tooltip (Vietnamese): "Outside 24 hours: staff messages are sent with the HUMAN_AGENT tag - human agents only, up to 7 days."` |
| 10.3 | Gõ tay câu trả lời: `Sorry for the late reply, our office was closed over the weekend. Here is the quote you asked for.` Bấm **Gửi** | `A human staff member types and sends the reply manually. Dezon Inbox applies the human_agent tag only to replies written by staff, never to automated messages.` |
| 10.4 | Bên phải: tin hiện trong Messenger của khách | `The customer receives the human agent's reply in Messenger.` |
| 10.5 | (Thêm khi dựng) khung chữ cuối | `After 7 days the composer is locked and no message can be sent.` |

> Nếu tin ở bước 10.3 báo **"Gửi lỗi"**: dừng, **không xin Human Agent lần này**, bỏ cảnh 10. Xem `QUYEN-VA-MO-TA.md` mục 6.

### Cảnh 11: Màn hình kết thúc (thêm khi dựng)

| Thao tác | Chú thích tiếng Anh |
| --- | --- |
| Khung chữ 3–4 giây | `All replies in Dezon Inbox are written and sent by Dezon staff. Customer data is visible only to logged-in Dezon employees.` |

### Cảnh 12: Gửi tin bằng API Integration Helper (quay riêng, nên có cho `pages_messaging`)

Hướng dẫn của Meta cho `pages_messaging` có nêu thêm việc tạo một lệnh cURL gửi tin, gợi ý dùng **API Integration Helper** trong trang quản lý app, mục Messenger. Quay thêm đoạn ngắn này cho chắc.

| # | Thao tác | Chú thích tiếng Anh |
| --- | --- | --- |
| 12.1 | Vào **Ứng dụng của tôi → Dezon Inbox → Messenger**, mở **API Integration Helper**. [CHƯA XÁC MINH] Tên tiếng Việt của mục này chưa được kiểm tra | `Meta App Dashboard > Messenger > API Integration Helper.` |
| 12.2 | Chọn Trang thử, chọn người nhận là người đóng vai khách, gõ một tin. Lệnh cURL hiện ra | `A cURL request to the Send API is generated for our Page.` |
| 12.3 | Bấm gửi. Bên phải (messenger.com của người đóng vai khách): tin hiện ra | `The message is delivered and displayed in the customer's Messenger.` |

Nếu thấy rối, có thể bỏ cảnh này: video chính (cảnh 8) đã cho thấy app gửi tin và Messenger nhận tin.

---

## Phần 3: Cắt thành video cho từng quyền

Sau khi đã thêm chú thích cho video gốc trong Clipchamp, nhân bản dự án (mỗi quyền một bản), xóa các cảnh không cần, rồi xuất 1080p MP4. Đặt tên tệp theo quyền để tải lên cho dễ.

Meta yêu cầu video của mỗi quyền cho thấy cả bước **người dùng cấp quyền** qua nút đăng nhập Facebook, rồi mới tới tính năng dùng quyền đó. Vì vậy các quyền xin qua hộp thoại Facebook (`pages_*`, `public_profile`) đều giữ cảnh 2 đến 4.

| Tệp | Quyền | Các cảnh |
| --- | --- | --- |
| `01-pages_messaging.mp4` | `pages_messaging` | 0, 1, 2, 3, 4, 5, 6, 7, 8, (12), 11 |
| `02-pages_manage_metadata.mp4` | `pages_manage_metadata` | 0, 1, 2, 3, 4, 5, 6, 7.1, 11 |
| `03-pages_show_list.mp4` | `pages_show_list` | 0, 1, 2, 3, 4, 11 |
| `04-pages_read_engagement.mp4` | `pages_read_engagement` | 0, 1, 2, 3, 4, 9, 11 |
| `05-business_asset_user_profile_access.mp4` | Business Asset User Profile Access | 0, 1, 5, 6, 7, 11 |
| `06-human_agent.mp4` | Human Agent (nếu xin) | 0, 1, 10, 11 |
| `07-public_profile.mp4` | `public_profile` (nếu form đòi video) | 0, 1, 2, 3, 4, 11 |

**[CHƯA XÁC MINH]** Không rõ Meta có chấp nhận tải **cùng một video đầy đủ** cho mọi quyền không. Cắt riêng như bảng trên là an toàn hơn.

---

## Phần 4: Danh sách kiểm tra

### Trước khi quay

- [ ] Hệ thống chạy trên địa chỉ HTTPS công khai: [ĐIỀN: địa chỉ]
- [ ] Trang thử đã xuất bản và **chưa kết nối** lúc bắt đầu quay
- [ ] Người đóng vai khách là người thật, đã được thêm làm **Người dùng thử** và đã chấp nhận lời mời
- [ ] Ngôn ngữ Facebook của cả hai tài khoản đã đổi sang English
- [ ] Trình duyệt A đã đăng xuất Dezon Inbox và Facebook. Trình duyệt B đã đăng nhập messenger.com bằng tài khoản đóng vai khách
- [ ] Màn hình 1440 × 900, con trỏ chuột to, bật Không làm phiền, đóng tab và ứng dụng khác
- [ ] Phần AI đang tắt
- [ ] (Nếu xin Human Agent) có hội thoại với tin cuối của khách cũ hơn 24 giờ, chưa quá 7 ngày; `META_HUMAN_AGENT_ENABLED=true`
- [ ] Trang thử có sẵn vài hội thoại cũ để quay cảnh Đồng bộ lịch sử

### Sau khi dựng, xem lại từng video

- [ ] Bắt đầu từ trạng thái **đã đăng xuất**, thấy cả bước đăng nhập
- [ ] Thấy rõ hộp thoại Facebook Login for Business và màn hình liệt kê quyền
- [ ] Thấy Trang hiện **Đã kết nối**
- [ ] Thấy tin khách gửi trong Messenger rồi **tự hiện** trong Dezon Inbox
- [ ] Thấy **tên và ảnh khách**
- [ ] Thấy nhân viên gửi và **Messenger của khách nhận** tin, trong cùng khung hình (không dùng ảnh chụp màn hình)
- [ ] Mỗi chữ tiếng Việt quan trọng đều có chú thích tiếng Anh, chú thích đủ lâu để đọc
- [ ] Không lộ khách thật, số điện thoại, email cá nhân, mật khẩu, mã xác thực hai bước
- [ ] Không có phần AI trên màn hình
- [ ] Xuất 1080p, MP4, mỗi video khoảng 2–5 phút, không cần tiếng
- [ ] Đủ một video cho mỗi quyền sẽ xin (xem bảng Phần 3)

### Sau khi quay

- [ ] Đổi lại độ phân giải và kích thước con trỏ chuột
- [ ] Nếu đã ngắt kết nối Trang để quay: kiểm tra Trang đã kết nối lại, tin vẫn về
- [ ] Giữ Trang thử ở trạng thái **đã kết nối** trong suốt thời gian Meta duyệt, để người duyệt thử được
