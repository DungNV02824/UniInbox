# Quyền xin Meta và nội dung dán vào form App Review

App: **Dezon Inbox**, App ID `1727184952398550`, loại app Business, hiện ở chế độ "Phát triển".
Soạn ngày 2026-11-05, dựa trên `docs/meta-app-review/research.md`.

## Cách dùng file này

- Mỗi quyền có hai phần:
  - **Giải thích cho anh/chị (tiếng Việt)**: để hiểu quyền này làm gì. Phần này **không** dán vào form.
  - **Mô tả dán vào form (tiếng Anh)**: chép nguyên khối trong ô xám, dán vào ô mô tả của đúng quyền đó. Người duyệt của Meta đọc tiếng Anh.
- Chỗ nào có `[ĐIỀN: ...]` thì thay bằng thông tin thật, rồi xóa luôn ngoặc vuông. Bấm Ctrl+F, gõ `ĐIỀN` để tìm hết.
- Meta yêu cầu mỗi quyền một mô tả riêng, **không chép y hệt** từ quyền này sang quyền khác. Các mô tả dưới đây đã được viết khác nhau, đừng gộp lại.
- Video cho từng quyền: xem `KICH-BAN-VIDEO.md`. Mỗi mục bên dưới có ghi "Video: cảnh số ...".

Đường đi trong trang Meta for Developers: **Ứng dụng của tôi → Dezon Inbox → Xét duyệt ứng dụng → Quyền và tính năng**. Mỗi quyền có nút **"Nhận quyền truy cập nâng cao"**.

> Nút này **bị mờ** cho tới khi Meta ghi nhận ít nhất một lần gọi API thành công bằng quyền đó trong 30 ngày gần nhất. Meta mất tới 2 ngày để ghi nhận. Xem mục "Việc cần làm trước khi gửi" ở cuối file.

---

## Thông tin chung cần có trước

| Thông tin | Giá trị |
| --- | --- |
| Địa chỉ công khai của hệ thống (HTTPS) | [ĐIỀN: ví dụ https://inbox.dezon.vn] |
| Link Chính sách quyền riêng tư | [ĐIỀN: ví dụ https://dezon.vn/chinh-sach-quyen-rieng-tu] |
| Link hướng dẫn Xóa dữ liệu | [ĐIỀN: ví dụ https://dezon.vn/xoa-du-lieu] |
| Email liên hệ quyền riêng tư | [ĐIỀN: support@dezon.vn (xác nhận lại)] |
| Trang Facebook dùng để thử | [ĐIỀN: tên Trang, ví dụ "Demo app"] |
| Link nhắn tin tới Trang đó | [ĐIỀN: https://m.me/tên-trang] |
| Tài khoản đăng nhập cho người duyệt | [ĐIỀN: email, ví dụ meta-review@dezon.vn] / [ĐIỀN: mật khẩu] |
| Nơi đặt máy chủ | [ĐIỀN: Việt Nam hoặc Singapore] |

**Lưu ý quan trọng:**

- **Hệ thống phải chạy trên địa chỉ HTTPS công khai trước khi gửi.** Hiện hệ thống chỉ chạy trên máy phát triển, chưa lên VPS. Nếu Meta không mở được app thì **toàn bộ hồ sơ bị từ chối**. Không được chặn theo quốc gia, VPN hay danh sách IP trong lúc duyệt.
- **Tài khoản cho người duyệt phải có vai trò Quản trị viên.** Chỉ Quản trị viên mới vào được **Quản trị → Kênh**, nơi có nút kết nối Facebook. Nhân viên thường bị chuyển về Hộp thư. Nên tạo một tài khoản riêng chỉ để Meta duyệt, rồi khóa hoặc đổi mật khẩu sau khi có kết quả.
- **[CẦN QUYẾT ĐỊNH] Người duyệt sẽ thấy tin nhắn thật.** Tài khoản Quản trị viên thấy hội thoại của mọi Trang đã kết nối, gồm cả khách thật. Hãy hỏi đội kỹ thuật: có thể tạm ngắt các Trang khác trong thời gian Meta duyệt không, hay chấp nhận rủi ro này.
- **Không dùng tài khoản Facebook cá nhân hay tài khoản giả trong hồ sơ.** Meta tự thử bằng tài khoản của họ. Tài khoản giả làm hồ sơ bị từ chối.

---

## Danh sách xin

| # | Quyền / tính năng | Mức xin | Bắt buộc? |
| --- | --- | --- | --- |
| 1 | `pages_messaging` | Nâng cao | **Bắt buộc** |
| 2 | `pages_manage_metadata` | Nâng cao | **Bắt buộc** (đi kèm quyền 1) |
| 3 | `pages_show_list` | Nâng cao | **Bắt buộc** (đi kèm quyền 1) |
| 4 | `pages_read_engagement` | Nâng cao | Nên xin (dùng cho Đồng bộ lịch sử) |
| 5 | Business Asset User Profile Access | Nâng cao | **Bắt buộc** để thấy tên và ảnh khách |
| 6 | Human Agent | Nâng cao | Tùy chọn (trả lời khách sau 24 giờ, tối đa 7 ngày) |
| 7 | `public_profile` | Nâng cao | **Bắt buộc** với app dùng Facebook Login for Business trước khi lên Chính thức |

**Không xin:**

- `business_management`: hệ thống chưa cần. Chỉ xin nếu sau này các Trang thuộc Business Portfolio không hiện ra khi kết nối.
- Bất cứ quyền nào cho AI trả lời tự động: tính năng AI thuộc giai đoạn sau, chưa có trong hệ thống. Xin quyền "để dành" là lý do bị từ chối phổ biến.
- Instagram, WhatsApp, quảng cáo, bài viết: hệ thống không dùng.

---

## 1. `pages_messaging` (bắt buộc)

### Giải thích cho anh/chị

- **Dùng để làm gì:** nhận tin khách nhắn vào Trang và gửi câu trả lời của nhân viên ngược lại Messenger. Đây là quyền chính, thiếu nó thì hệ thống không chạy.
- **Luồng sử dụng:** khách nhắn vào Trang trên Messenger → Meta báo về hệ thống qua webhook → hội thoại hiện trong **Hộp thư** → nhân viên bấm vào, gõ trả lời ở ô dưới cùng, bấm **Gửi** → khách nhận được trên Messenger. Tin có trạng thái "Đang gửi → Đã gửi → Đã nhận → Đã xem".
- **Vì sao cần:** không có quyền ở mức Nâng cao thì chỉ người có vai trò trong app (như Đúng Văn) nhắn mới về. Khách thật như Tuấn Kiệt, Cao Hung không về được.
- **Dữ liệu:** nội dung tin, ảnh và tệp đính kèm, mã khách (PSID). Lưu trong cơ sở dữ liệu và kho tệp của Dezon. Chỉ nhân viên Dezon đăng nhập mới xem được.
- **Video:** cảnh 1 đến 8 (và cảnh 12 nếu quay). Tệp `01-pages_messaging.mp4` trong `KICH-BAN-VIDEO.md` Phần 3.

### Mô tả dán vào form

```text
Dezon Inbox is an internal customer-support web app used only by employees of Dezon (dezon.vn), a design company in Vietnam. It brings the Messenger conversations of Dezon's own Facebook Pages into one shared inbox so our sales and support staff can answer customers quickly. Only Dezon staff with an account can log in; customers never use the app directly.

How we use pages_messaging:
1. A customer sends a message to one of Dezon's Facebook Pages in Messenger.
2. Our webhook receives the message event and the conversation appears at the top of the Dezon Inbox conversation list within a few seconds.
3. A Dezon staff member opens the conversation, types a reply (text or an image/file) and clicks Send.
4. Dezon Inbox calls the Send API with the Page access token, and the customer receives the reply in Messenger. Delivery and read receipts update the message status in the inbox.

All replies today are written and sent by Dezon staff. Dezon Inbox does not send promotional or bulk messages, and it does not send automated replies. Messages are only sent in response to a customer who wrote to the Page first: within Messenger's standard 24-hour messaging window, or, only if the Human Agent feature is approved, as a human agent reply within 7 days using the HUMAN_AGENT tag. An AI reply assistant is planned for a later version; it is not part of this submission, and we will update our privacy policy and follow Messenger policies before enabling it.

Why it is necessary: answering customers is the only purpose of the app. Without Advanced Access for pages_messaging we can only receive and answer messages from people who have a role on our app, so real customers who message our Pages would go unanswered.

Data handling: we store message text, attachments and the customer's Page-scoped ID in our own database and file storage on servers in [ĐIỀN: Vietnam / Singapore], visible only to logged-in Dezon staff. Page access tokens are stored encrypted. We never sell this data, and we share it only with the hosting and storage providers that process it on our behalf. Customers can request deletion as described at [ĐIỀN: link trang Xóa dữ liệu].

The screen recording shows: logging in to Dezon Inbox, connecting our Page through Facebook Login for Business, a customer test account sending a message in Messenger (right side of the screen), the message arriving in Dezon Inbox (left side), a staff member replying, and the reply being displayed in the Messenger client.
```

---

## 2. `pages_manage_metadata` (bắt buộc)

### Giải thích cho anh/chị

- **Dùng để làm gì:** đăng ký cho Trang "gửi tin về hệ thống" (webhook). Mỗi khi kết nối một Trang, hệ thống tự làm bước này. Không có bước này thì Trang không báo tin mới về.
- **Luồng sử dụng:** **Quản trị → Kênh → Kết nối → Facebook** → đăng nhập Facebook, chọn Trang → bấm **Kết nối** → Trang hiện trong danh sách với trạng thái **"Đã kết nối"**. Từ lúc đó tin mới của Trang tự về Hộp thư.
- **Vì sao cần:** Meta bắt buộc quyền này đi kèm `pages_messaging`.
- **Dữ liệu:** không lấy thêm dữ liệu khách. Chỉ lưu mã Trang, tên Trang và Page token đã mã hóa.
- **Video:** cảnh 1 đến 6 và 7.1 (tệp `02-pages_manage_metadata.mp4`).

### Mô tả dán vào form

```text
Dezon Inbox uses pages_manage_metadata for one thing: to subscribe each Dezon Facebook Page that a staff admin connects to our app's Messenger webhook (POST /{page-id}/subscribed_apps). This is what makes new customer messages, delivery receipts and read receipts reach our inbox in real time. pages_manage_metadata is also a required dependency of pages_messaging.

User flow: a Dezon admin logs in to Dezon Inbox, opens Admin > Channels ("Quản trị > Kênh" in our Vietnamese UI), clicks "Connect" > "Facebook", completes Facebook Login for Business and selects the Pages to connect. Dezon Inbox then subscribes each selected Page to the webhook automatically and shows the Page as "Connected".

Why it is necessary: without this subscription the Page never notifies our app about new messages, so staff would not see customer messages at all and the inbox would not work.

Data handling: this permission does not give us customer data. We store only the Page ID, Page name and the Page access token (encrypted at rest). We do not change any other Page settings.

The screen recording shows the admin connecting a Page and the Page appearing as connected, followed by a new customer message arriving in the inbox through the webhook.
```

---

## 3. `pages_show_list` (bắt buộc)

### Giải thích cho anh/chị

- **Dùng để làm gì:** sau khi đăng nhập Facebook, lấy danh sách các Trang mà người đó quản lý để chọn Trang cần kết nối (hộp thoại **"Chọn Trang để kết nối"**).
- **Vì sao cần:** Meta bắt buộc quyền này đi kèm `pages_messaging`. Meta cũng dặn phải ghi rõ quyền chính là gì trong mô tả.
- **Dữ liệu:** tên và mã các Trang. Chỉ lưu những Trang được chọn.
- **Video:** cảnh 1 đến 4 (tệp `03-pages_show_list.mp4`).

### Mô tả dán vào form

```text
pages_show_list is requested as a dependency of our main permission, pages_messaging.

Dezon Inbox uses it during the Page connection step. After a Dezon admin completes Facebook Login for Business from Admin > Channels > Connect > Facebook, we call /me/accounts to list the Facebook Pages that this admin manages. They are shown in a "Select Pages to connect" dialog ("Chọn Trang để kết nối" in our Vietnamese UI), with a note when a Page cannot be used for messaging. The admin ticks the Pages they want and clicks "Connect". The connected Pages then appear in the Channels list and their Messenger conversations start arriving in the shared inbox.

Why it is necessary: Dezon manages several Facebook Pages. Without the list of Pages the admin manages, we could not let them choose which Pages to bring into the inbox, and we could not obtain the Page access token needed for pages_messaging.

Data handling: we only read Page names, Page IDs and Page access tokens. We store only the Pages the admin selects (tokens encrypted at rest) and discard the rest when the connection step ends (at the latest after 15 minutes).

The screen recording shows the login dialog, the list of the admin's Pages, and the selected Pages successfully connected in Dezon Inbox.
```

---

## 4. `pages_read_engagement` (nên xin)

### Giải thích cho anh/chị

- **Dùng để làm gì:** nút **"Đồng bộ lịch sử"** trong **Quản trị → Kênh** kéo các hội thoại cũ của Trang (ví dụ 30 ngày gần nhất) vào Hộp thư, để nhân viên thấy đủ tin của mọi khách, kể cả tin cũ trước khi kết nối. Tài liệu của Meta về Conversations API ghi rõ cần quyền này.
- **Rủi ro:** hướng dẫn quay video của Meta cho quyền này nói về "xem nội dung bài viết của Trang", không khớp với một hộp thư. Người duyệt có thể hỏi lại hoặc từ chối. **Nếu bị từ chối quyền này, các quyền khác vẫn được duyệt bình thường** và hệ thống vẫn nhận, trả lời tin mới qua webhook. Chỉ mất phần kéo tin cũ.
- **Chưa rõ:** ở chế độ Phát triển, hệ thống vẫn đọc được hội thoại cũ của khách không có vai trò dù chưa có quyền này. Điều đó trái tài liệu, Meta có thể chặn bất cứ lúc nào, nên vẫn xin.
- **Dữ liệu:** tin nhắn cũ, tên người trong hội thoại.
- **Video:** cảnh 1 đến 4 (đăng nhập và cấp quyền) và cảnh 9 (tệp `04-pages_read_engagement.mp4`).

### Mô tả dán vào form

```text
We request pages_read_engagement because Meta's Conversations API documentation lists it, together with pages_messaging and pages_manage_metadata, as required to read Messenger conversations between people and a Page. Dezon Inbox does not read or display Page posts, photos, videos, events or insights.

How we use it: in Admin > Channels, each connected Page has a "Sync history" button ("Đồng bộ lịch sử" in our Vietnamese UI). When a Dezon admin clicks it and chooses a time range (for example the last 30 days), Dezon Inbox calls /{page-id}/conversations and the conversation messages endpoint to import that Page's recent Messenger conversations, including participant names, into the shared inbox. The same import runs once automatically right after a Page is connected.

Why it is necessary: the webhook only delivers messages sent after a Page is connected. Without the history import, our staff would open a conversation and see only the latest message, without the earlier questions, quotes and order details the customer already sent. They would have to switch back to the Page inbox in Meta Business Suite to understand the context, which defeats the purpose of a single shared inbox.

Data handling: imported messages are stored in the same way as live messages (our own database on servers in [ĐIỀN: Vietnam / Singapore], visible only to logged-in Dezon staff) and are covered by the same deletion process described at [ĐIỀN: link trang Xóa dữ liệu].

The screen recording shows the admin granting this permission in the Facebook Login for Business dialog, then clicking "Sync history" for a connected Page and the earlier conversations appearing in the inbox.
```

---

## 5. Business Asset User Profile Access (bắt buộc để thấy tên và ảnh khách)

### Giải thích cho anh/chị

- **Dùng để làm gì:** lấy **tên** và **ảnh đại diện** của khách khi khách nhắn vào Trang. Không có tính năng này, Hộp thư chỉ hiện một dãy số thay cho tên khách.
- **Luồng sử dụng:** khách nhắn lần đầu → hệ thống hỏi Meta tên và ảnh của khách → hiện ở danh sách hội thoại, đầu khung chat và cột **Thông tin khách** bên phải. Nhân viên có thể sửa tên hiển thị, thêm ghi chú và tag.
- **Dữ liệu:** tên, ảnh đại diện, mã khách (PSID). Không lấy email, số điện thoại hay thông tin khác từ Facebook.
- **Video:** cảnh 1, 5, 6, 7 (phóng to vào tên và ảnh khách; tệp `05-business_asset_user_profile_access.mp4`).

### Mô tả dán vào form

```text
Dezon Inbox uses the Business Asset User Profile Access feature to show who is writing to Dezon's Facebook Pages. When a customer messages one of our Pages for the first time, we call the User Profile API with the customer's Page-scoped ID and read only their name and profile picture.

Where it appears: the customer's name and picture are shown in the conversation list, at the top of the open conversation and in the customer details panel ("Thông tin khách" in our Vietnamese UI). Staff can add internal notes and tags to the customer record so that colleagues know the history of the request.

Why it is necessary: several staff members share one inbox for multiple Pages. Without the name and picture, every conversation would show only a numeric ID. Staff could not tell customers apart, greet them by name, or recognise a returning customer, and the risk of replying in the wrong conversation would be much higher.

Data handling: we only request the name and profile picture fields. We do not read or store email, phone number or any other profile data from Meta. The data is stored in our own database and file storage on servers in [ĐIỀN: Vietnam / Singapore], visible only to logged-in Dezon staff, used only to support the customer's own conversation, never sold or used for advertising, and shared only with the hosting and storage providers that process it on our behalf. Customers can request deletion as described at [ĐIỀN: link trang Xóa dữ liệu].

The screen recording shows a customer test account sending a message in Messenger and the conversation appearing in Dezon Inbox with that customer's name and profile picture.
```

---

## 6. Human Agent (tùy chọn)

### Giải thích cho anh/chị

- **Dùng để làm gì:** Meta chỉ cho Trang trả lời khách trong **24 giờ** kể từ tin cuối của khách. Human Agent cho phép **nhân viên (người thật)** trả lời thêm tới **7 ngày**. Ví dụ: khách nhắn tối thứ Sáu, nhân viên trả lời sáng thứ Hai; hoặc cần báo giá phải làm hơn một ngày.
- **Luồng sử dụng:** khi đã qua 24 giờ nhưng chưa quá 7 ngày, đầu khung chat hiện huy hiệu **HUMAN_AGENT**. Rê chuột vào sẽ thấy dòng giải thích "Ngoài 24 giờ: tin của nhân viên được gắn tag HUMAN_AGENT (chỉ người thật, tối đa 7 ngày)". Nhân viên gõ trả lời và bấm Gửi như bình thường. Hệ thống tự gắn tag cho tin đó.
- **Điều kiện bắt buộc:** chỉ dùng cho tin **do nhân viên tự viết**. Không bao giờ dùng cho tin tự động hay tin quảng cáo. Khi làm tính năng AI sau này, tin AI tuyệt đối không được gắn tag này.
- **Kỹ thuật:** tính năng đang tắt (`META_HUMAN_AGENT_ENABLED=false`). Nhờ đội kỹ thuật bật trước khi quay cảnh 10.
- **[CHƯA XÁC MINH]** Chưa chắc tag này gửi được trước khi Meta duyệt, kể cả với người có vai trò trong app. Nếu khi quay cảnh 10 tin báo **"Gửi lỗi"**, hãy **bỏ Human Agent khỏi lần gửi này** và xin sau. Không ảnh hưởng các quyền khác.
- **Video:** cảnh 1 và 10 (tệp `06-human_agent.mp4`).

### Mô tả dán vào form

```text
Dezon Inbox uses the human_agent message tag only for replies typed by a Dezon staff member, never for automated messages. Dezon Inbox does not send automated replies today, and the tag is applied exclusively to messages sent by a logged-in human agent from the inbox composer.

When it is used: Dezon is a design company and many customer requests cannot be answered within 24 hours. A customer may write on Friday evening when our office is closed, or ask for a quote or design option that takes our team more than a day to prepare. When the 24-hour window has passed but the customer's last message is less than 7 days old, the conversation header shows a "HUMAN_AGENT" badge explaining that the reply will be sent by a human agent. The staff member types the answer and clicks Send, and Dezon Inbox sends it with the HUMAN_AGENT tag. After 7 days the composer is locked and no message can be sent.

Why it is necessary: without this feature, a customer who wrote just before a weekend or holiday, or whose request needs research, could never receive the answer they asked for through Messenger, and our staff would have to ask them to write again.

We do not use the tag for promotions, marketing, surveys, re-engagement or any message the customer did not ask for.

The screen recording shows a conversation whose last customer message is more than 24 hours old, the HUMAN_AGENT badge in the header, a staff member typing and sending a reply manually, and the reply arriving in the customer's Messenger.
```

---

## 7. `public_profile` (bắt buộc với Facebook Login for Business)

### Giải thích cho anh/chị

- **Dùng để làm gì:** khi nhân viên Quản trị bấm **Kết nối → Facebook**, Facebook trả về tên tài khoản Facebook vừa đăng nhập. Hệ thống dùng nó để nhóm các Trang theo tài khoản Facebook trong trang Kênh.
- **Vì sao cần:** tài liệu của Meta ghi rõ app dùng Facebook Login for Business phải có quyền này ở mức Nâng cao trước khi lên Chính thức.
- **[CHƯA XÁC MINH]** Chưa rõ quyền này bấm một nút là có, hay phải kèm video như các quyền khác. Vào **Xét duyệt ứng dụng → Quyền và tính năng**: nếu chỉ cần bấm **"Nhận quyền truy cập nâng cao"** là xong thì bấm luôn. Nếu form hỏi mô tả thì dán khối dưới đây.
- **Dữ liệu:** tên và mã tài khoản Facebook của nhân viên Dezon, không phải của khách. Token đăng nhập của nhân viên chỉ dùng trong lúc kết nối, không được lưu lại.
- **Video:** cảnh 1 đến 4 (tệp `07-public_profile.mp4`, chỉ khi form đòi video).

### Mô tả dán vào form

```text
Dezon Inbox uses Facebook Login for Business only for Dezon admins to connect the company's Facebook Pages. public_profile is requested because Meta requires Advanced Access to public_profile for Facebook Login for Business apps before they go live.

We use the logged-in admin's name and ID only to show which Facebook account each group of connected Pages belongs to on the Admin > Channels screen ("Quản trị > Kênh" in our Vietnamese UI), so that admins know whose login to renew when a Page needs to be reconnected. This data belongs to Dezon employees, not to customers, and is not used for any other purpose. The Facebook user access token is used only during the connection step and is not stored.

Staff log in to Dezon Inbox itself with their company email and password; Facebook Login for Business appears only in Admin > Channels > Connect > Facebook.

The screen recording shows the admin opening the Facebook Login for Business dialog, granting access, and the connected Pages appearing grouped under that Facebook account.
```

---

## Hướng dẫn cho người duyệt (dán vào ô "Hướng dẫn kiểm thử" / App Verification)

### Giải thích cho anh/chị

- Ô này nằm ở bước **"Complete App Verification"** của form xét duyệt, và lại xuất hiện trong phần Data Use Checkup.
- Người duyệt không đọc được tiếng Việt, nên khối dưới đây dịch luôn từng nút: chữ tiếng Việt trong ngoặc kép là chữ đúng như trên màn hình.
- Trước khi dán, kiểm tra lại: tài khoản người duyệt đăng nhập được, có vai trò Quản trị viên, Trang thử đã kết nối, và gửi thử một tin từ m.me thấy về Hộp thư.
- Câu cuối của khối (về Standard Access) giải thích lý do nếu tin của người duyệt không về được: khi chưa được duyệt, Meta chỉ chuyển tin của người có vai trò trong app. Điều này đúng theo tài liệu của Meta.

### Khối dán vào form

```text
Dezon Inbox is a web app used only by Dezon employees. Its interface is in Vietnamese; the exact Vietnamese labels are given in quotes below so you can find each button.

URL: [ĐIỀN: https://inbox.dezon.vn]
Login (Dezon staff account with the Admin role, created for this review):
  Email: [ĐIỀN: meta-review@dezon.vn]
  Password: [ĐIỀN: mật khẩu]
This is a Dezon Inbox account, not a Facebook account. Staff log in with email and password; Facebook Login for Business is used only to connect Pages (step 3).

Test Page already connected: [ĐIỀN: tên Trang] - [ĐIỀN: https://www.facebook.com/tên-trang]

1. Log in
   Open the URL, enter the email in "Email" and the password in "Mật khẩu" (Password), click "Đăng nhập" (Log in). You land on the shared inbox ("Hộp thư").

2. Receive a message (pages_messaging, Business Asset User Profile Access)
   From any Facebook account, open [ĐIỀN: https://m.me/tên-trang] and send a message, e.g. "Hello, I would like a quote".
   Within a few seconds the conversation appears at the top of the conversation list in Dezon Inbox, showing the sender's name and profile picture. You can narrow the list to the test Page with the filter chip "[ĐIỀN: tên Trang]".

3. Reply (pages_messaging)
   Click the conversation. Type a reply in the box at the bottom ("Nội dung tin nhắn" = Message) and press Enter or click the send button ("Gửi" = Send).
   The reply is delivered to the sender in Messenger. Its status under the bubble changes from "Đang gửi" (Sending) to "Đã gửi" (Sent), "Đã nhận" (Delivered) and "Đã xem" (Seen).

4. Connect a Page with Facebook Login for Business (pages_show_list, pages_manage_metadata, public_profile)
   Click "Quản trị" (Admin) in the top bar. The "Kênh" (Channels) page opens.
   Click "Kết nối" (Connect), then "Facebook". The Facebook Login for Business dialog opens. Log in with a Facebook account that manages a Page and grant the requested permissions.
   Back in Dezon Inbox, the dialog "Chọn Trang để kết nối" (Select Pages to connect) lists the Pages you manage. Tick one or more and click "Kết nối (n)" (Connect).
   The Page appears in the Channels list as "Đã kết nối" (Connected) and is subscribed to our webhook automatically.

5. Sync conversation history (pages_read_engagement)
   On the Channels page, click "Đồng bộ lịch sử" (Sync history) on a connected Page, choose a range in "Khoảng thời gian" (Time range) and click "Đồng bộ" (Sync). Earlier Messenger conversations of that Page appear in the inbox after a short time.

6. Human Agent (only if requested)
   In a conversation whose last customer message is more than 24 hours and less than 7 days old, the conversation header shows a "HUMAN_AGENT" badge. A staff member types a reply manually and sends it; it is delivered with the human_agent tag. Dezon Inbox never applies this tag to automated messages.

Note: until Advanced Access is approved, Meta delivers webhooks only for people who have a role on our app, so a message sent from your own test account may not appear in the inbox before approval. The screen recordings show the complete flow end to end using an app tester account. If you need anything else to test, please contact [ĐIỀN: email liên hệ, ví dụ support@dezon.vn (xác nhận lại)].
```

---

## Phần trả lời về dữ liệu (dùng cho "Data Handling Questions" và Data Use Checkup)

Đây là ghi chú để anh/chị trả lời các câu hỏi về dữ liệu trong form. Meta khuyên hỏi ý kiến người phụ trách pháp lý trước khi trả lời. Chỉ chọn "Có" cho những gì **đang thật sự làm**.

| Câu hỏi thường gặp | Câu trả lời gợi ý | Ghi chú |
| --- | --- | --- |
| Ai xử lý dữ liệu thay mặt Dezon? | Nhà cung cấp VPS: [ĐIỀN: tên nhà cung cấp]. Nhà cung cấp lưu trữ tệp: [ĐIỀN: tên, nếu thuê ngoài] | Khi có AI, nhà cung cấp mô hình AI cũng phải khai báo. Mỗi bên phải cam kết bằng văn bản chỉ xử lý dữ liệu theo chỉ đạo của Dezon (Điều khoản nền tảng của Meta, mục 5.a) |
| Dữ liệu lưu ở nước nào? | [ĐIỀN: Việt Nam / Singapore] | Phải khớp với Chính sách quyền riêng tư |
| Có chia sẻ dữ liệu cho cơ quan nhà nước không? | [ĐIỀN: theo chính sách của công ty, ví dụ "chỉ khi có yêu cầu hợp pháp"] | Hỏi người phụ trách pháp lý |
| Mã hóa? | Page token được mã hóa khi lưu (AES-256-GCM); truy cập qua HTTPS | Mã hóa token: đã có trong code. HTTPS: chỉ đúng khi hệ thống đã lên máy chủ thật |
| Ai được xem dữ liệu? | Chỉ nhân viên Dezon có tài khoản, phân quyền Quản trị viên / Nhân viên | Đã có trong hệ thống |
| Giữ dữ liệu bao lâu? | Dữ liệu webhook gốc xóa sau 90 ngày; dữ liệu khách xóa theo yêu cầu | **[ĐIỀN/XÁC NHẬN]** Việc tự xóa sau 90 ngày mới là kế hoạch. Chỉ ghi câu này khi đội kỹ thuật xác nhận đã chạy |
| Khách yêu cầu xóa dữ liệu thế nào? | Theo trang [ĐIỀN: link trang Xóa dữ liệu] | **[ĐIỀN/XÁC NHẬN]** Phải có người và cách xử lý thật trước khi khai báo, kể cả xử lý tay |

Pháp luật Việt Nam (Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân) không phải yêu cầu của Meta. Nên nhờ luật sư xem Chính sách quyền riêng tư.

---

## Việc cần làm trước khi gửi

1. **Xác minh doanh nghiệp xong** và app đã gắn với Business Portfolio đã xác minh (**Cài đặt ứng dụng → Thông tin cơ bản → Xác minh**). Human Agent và Business Asset User Profile Access chỉ xin được sau khi xác minh.
2. **Hệ thống chạy trên địa chỉ HTTPS công khai**, chứng chỉ hợp lệ. Webhook trong Meta trỏ về địa chỉ đó.
3. **Điền đủ Thông tin cơ bản:** biểu tượng 1024×1024 (không dùng logo Facebook hay Messenger), link Chính sách quyền riêng tư, link Xóa dữ liệu, hạng mục, email liên hệ, mục đích app chọn **"Yourself or your own business"** (nhãn tiếng Việt chưa chắc), thêm nền tảng Website với địa chỉ của hệ thống. Chi tiết: `HUONG-DAN.md` mục B.
4. **Trang thử đã xuất bản** (không ẩn), đã kết nối vào hệ thống.
5. **Thêm `pages_read_engagement` vào quyền xin khi kết nối Facebook.** Hiện code chỉ xin `pages_show_list`, `pages_manage_metadata`, `pages_messaging` lúc đăng nhập Facebook (nếu dùng `config_id` thì quyền lấy theo cấu hình Facebook Login for Business trên Meta). Nhờ đội kỹ thuật thêm `pages_read_engagement`. Nếu không thêm, Meta sẽ không ghi nhận lần gọi API cho quyền này và hộp thoại Facebook trong video cũng không hiện quyền này.
6. **Đăng ký thêm sự kiện webhook `messaging_policy_enforcement`** (Messenger → Cài đặt → Webhook). Hiện chưa đăng ký. Meta yêu cầu cho app Messenger để báo khi app vi phạm chính sách. Nhờ đội kỹ thuật kiểm tra hệ thống nhận sự kiện này không lỗi.
7. **Gọi API thành công cho từng quyền trong 30 ngày gần nhất**, rồi chờ tới 2 ngày để nút "Nhận quyền truy cập nâng cao" sáng lên. Cách làm: thêm một người làm **Người dùng thử** trong **Vai trò trong ứng dụng**, rồi dùng hệ thống như thật:
   - Kết nối Trang bằng **Kết nối → Facebook** → dùng `pages_show_list`, `pages_manage_metadata`, `public_profile`.
   - Người dùng thử nhắn vào Trang, tin hiện tên và ảnh → dùng Business Asset User Profile Access.
   - Nhân viên trả lời → dùng `pages_messaging`.
   - Bấm **Đồng bộ lịch sử** → dùng `pages_read_engagement`.
   - (Nếu xin Human Agent) gửi một tin ngoài 24 giờ với tag HUMAN_AGENT.
8. **Tạo tài khoản người duyệt** (vai trò Quản trị viên), thử đăng nhập bằng trình duyệt ẩn danh.
9. **Giữ tắt AI** (`FEATURE_AI_ENABLED=false`) trong lúc quay và duyệt, để giao diện không hiện phần AI chưa có.
10. **Quay và cắt video** theo `KICH-BAN-VIDEO.md`.
11. **Không sửa cài đặt app sau khi gửi**: Meta có thể bắt duyệt lại.

## Sau khi Meta duyệt

1. Gạt **Chế độ của ứng dụng** sang **Chính thức**. Meta có thể yêu cầu làm **Data Use Checkup** trước khi gạt.
2. Nhờ một người **không có vai trò** trong app (ví dụ Tuấn Kiệt) nhắn vào Trang, kiểm tra tin về Hộp thư và trả lời được.
3. Nếu có xin Human Agent: nhờ đội kỹ thuật bật `META_HUMAN_AGENT_ENABLED=true`.
4. Mỗi năm Meta yêu cầu làm lại Data Use Checkup. Đặt lịch nhắc.
5. Khi làm tính năng AI trả lời tự động: cập nhật Chính sách quyền riêng tư (nêu rõ nhà cung cấp AI), báo khách rằng đang chat với hệ thống tự động khi luật yêu cầu, và không gắn tag HUMAN_AGENT cho tin của AI.

## Các điểm chưa chắc chắn

- **[CHƯA XÁC MINH]** `public_profile` có cần video không, hay bấm một nút là có.
- **[CHƯA XÁC MINH]** Tag HUMAN_AGENT có gửi được trước khi duyệt không.
- **[CHƯA XÁC MINH]** Người duyệt của Meta có tự kết nối được một Trang họ quản lý không. Video và Trang đã kết nối sẵn bù cho phần này.
- **[CHƯA RÕ]** Meta có chấp nhận `pages_read_engagement` cho một hộp thư không. Nếu không, bỏ quyền này, hệ thống vẫn chạy với tin mới.
- **[CHƯA RÕ]** Tài liệu của Meta nói app loại Business "không có chế độ", nhưng trang quản lý vẫn hiện nút Phát triển / Chính thức. Cứ làm cả hai: được duyệt rồi gạt sang Chính thức.
