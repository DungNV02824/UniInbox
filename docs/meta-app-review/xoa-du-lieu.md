# [GHI CHÚ NỘI BỘ: không đăng phần này]

**Dán URL này vào trường nào của Meta:**

- Cài đặt ứng dụng → Thông tin cơ bản → mục **"Xóa dữ liệu người dùng"** → chọn **"URL hướng dẫn xóa dữ liệu"**, rồi dán URL. Tiếng Anh: Settings → Basic → **User data deletion** → **Data deletion instructions URL**.
- Tên trường tiếng Việt chưa được đối chiếu với giao diện thật. Nếu khác, tìm ô có chữ "xóa dữ liệu" / "Data deletion".
- **Không** chọn "URL gọi lại yêu cầu xóa dữ liệu" (Data deletion callback URL). Hệ thống chưa làm chức năng gọi lại. Theo research (mục 5), chức năng này chỉ áp dụng cho nhân viên đăng nhập bằng Facebook, không áp dụng cho khách nhắn tin.
- URL gợi ý: `https://dezon.vn/xoa-du-lieu`. Trang phải nằm trên tên miền dezon.vn, dùng HTTPS, ai cũng mở được.

**Việc phải làm trước khi đăng:**

1. Tìm và điền mọi chỗ `[ĐIỀN: ...]`, cả bản tiếng Việt và tiếng Anh. Nếu chưa có biểu mẫu web, xóa cả dòng "Cách 3".
2. Xác nhận lại email `support@dezon.vn`.
3. Trang này hứa **xóa xong trong 72 giờ**. Hiện hệ thống **chưa có** chức năng "xóa dữ liệu một khách" (đặc tả mục 11 có kế hoạch nhưng chưa làm). Trước khi đăng, cần một trong hai:
   - làm xong chức năng xóa (xóa contact, mọi danh tính, tin nhắn, tệp trong kho lưu tệp, ảnh đại diện, ghi chú, nhãn, tóm tắt AI); hoặc
   - có quy trình xóa thủ công mà người kỹ thuật làm được trong 72 giờ. Lưu ý: xóa khách trong cơ sở dữ liệu sẽ xóa kèm danh tính, hội thoại và tin nhắn (kể cả bản gốc webhook nằm trong tin), nhưng **tệp đính kèm và ảnh đại diện trong kho lưu tệp phải xóa riêng**.
   - Trang này còn hứa: sau khi gửi xác nhận, xóa luôn tin yêu cầu và tin xác nhận khỏi Dezon Inbox. Nhớ làm bước này.
4. Phân công người đọc email và tin "XÓA DỮ LIỆU" hằng ngày. Lưu sổ theo dõi yêu cầu (ngày nhận, mã xác nhận, ngày xóa xong), không lưu nội dung tin.
5. Đường dẫn trong cài đặt Facebook (mục 8) có thể khác tùy phiên bản ứng dụng. Trang đã ghi rõ điều này.
6. Thời hạn 72 giờ dựa trên cách hiểu về Điều 16 Nghị định 13/2023/NĐ-CP, **cần kiểm tra lại** (không có trong research). Luật sư có thể đổi, nhưng phải đổi đồng thời ở trang này và ở Chính sách quyền riêng tư.
7. Câu "bản tạm trong hàng đợi tự xóa sau tối đa 7 ngày" (mục 6) đúng với cấu hình hàng đợi hiện tại trong code. Nếu đội kỹ thuật đổi cấu hình thì sửa theo.

**Cách đăng lên dezon.vn:** giống trang Chính sách quyền riêng tư.

- **Cách A (WordPress):** tạo Trang mới, đặt đường dẫn (slug) `xoa-du-lieu`. Thêm khối **"HTML tùy chỉnh"**. Dán phần nằm giữa `<!-- DEZON-POLICY:START -->` và `<!-- DEZON-POLICY:END -->` của file `xoa-du-lieu.html`.
- **Cách B:** tải cả file .html lên thư mục gốc của website. Khi đó URL là `https://dezon.vn/xoa-du-lieu.html`.
- Trang này có link cứng tới `https://dezon.vn/chinh-sach-quyen-rieng-tu`. Nếu dùng Cách B hoặc đường dẫn khác, sửa link cho khớp URL thật, trong cả 2 file (Ctrl+F tìm `dezon.vn/`).

<!-- PUBLIC:START -->

# Hướng dẫn xóa dữ liệu của Dezon Inbox

Cập nhật lần cuối: 05/11/2026

<!-- LANG:vi -->

Dezon Inbox là phần mềm hộp thư nội bộ. Nhân viên của [ĐIỀN: tên pháp lý công ty] ("Dezon") dùng nó để trả lời tin nhắn gửi tới các Trang Facebook của Dezon. Trang này hướng dẫn cách yêu cầu Dezon xóa dữ liệu của bạn khỏi Dezon Inbox. Thông tin đầy đủ về cách chúng tôi xử lý dữ liệu có trong [Chính sách quyền riêng tư](https://dezon.vn/chinh-sach-quyen-rieng-tu).

## 1. Ai có thể yêu cầu xóa

- Bất kỳ ai đã nhắn tin cho một Trang Facebook của Dezon.
- Nhân viên hoặc quản trị viên Trang đã đăng nhập Facebook để kết nối Trang với Dezon Inbox.

Yêu cầu xóa hoàn toàn **miễn phí**.

## 2. Dezon Inbox lưu gì về bạn

- Tên hiển thị và ảnh đại diện Facebook của bạn.
- Mã định danh theo Trang (PSID) mà Meta cấp.
- Tin nhắn qua lại với Trang của Dezon và tệp đính kèm (ảnh, video, tệp...).
- Thông tin bạn cung cấp trong trò chuyện, như số điện thoại hay email.
- Ghi chú và nhãn nhân viên Dezon gắn cho cuộc trò chuyện.
- Với người đã kết nối Trang: ID người dùng theo ứng dụng và tên Facebook. Token đăng nhập Facebook của bạn không được lưu.

## 3. Cách gửi yêu cầu

**Cách 1: Nhắn tin cho Trang (nhanh nhất).** Vào đúng Trang Facebook của Dezon mà bạn đã nhắn, gửi tin: **XÓA DỮ LIỆU**. Chúng tôi nhận ra tài khoản của bạn ngay, nên bạn không cần cung cấp thêm gì.

**Cách 2: Gửi email** tới [support@dezon.vn](mailto:support@dezon.vn), tiêu đề **"Yêu cầu xóa dữ liệu"**, kèm:

- tên Facebook của bạn;
- tên Trang Dezon bạn đã nhắn;
- khoảng thời gian bạn đã nhắn (gần đúng là được);
- tùy chọn: ảnh chụp màn hình cuộc trò chuyện hoặc đường dẫn tới trang cá nhân Facebook của bạn;
- email hoặc kênh bạn muốn nhận xác nhận.

**Cách 3: Biểu mẫu:** [ĐIỀN: đường dẫn biểu mẫu, xóa dòng này nếu không có]

Vui lòng **không** gửi ảnh căn cước hay giấy tờ tùy thân. Chúng tôi không cần những thứ đó.

## 4. Chúng tôi xử lý thế nào

1. Chúng tôi xác nhận đã nhận yêu cầu. Nếu bạn gửi bằng email, chúng tôi có thể nhờ bạn nhắn một mã ngắn từ chính tài khoản Messenger đó, để chắc chắn bạn là chủ tài khoản.
2. Chúng tôi xóa dữ liệu **trong vòng 72 giờ** kể từ khi xác minh xong.
3. Chúng tôi gửi xác nhận đã xóa kèm **mã xác nhận**, qua email hoặc Messenger. Sau đó chúng tôi cũng xóa khỏi Dezon Inbox tin yêu cầu và tin xác nhận này, chỉ giữ bản ghi tối thiểu nêu ở mục 6.
4. Muốn hỏi tình trạng yêu cầu, bạn trả lời email hoặc nhắn cho Trang kèm mã xác nhận. Nếu chúng tôi không thể xóa một phần dữ liệu, chúng tôi sẽ nêu rõ lý do.

## 5. Những gì sẽ bị xóa

- Hồ sơ khách: tên, ảnh đại diện (cả bản sao trong kho lưu tệp), số điện thoại và email đã lưu.
- Mọi mã định danh (PSID) của bạn trên các Trang của Dezon.
- Toàn bộ tin nhắn hai chiều.
- Mọi tệp đính kèm trong kho lưu tệp.
- Ghi chú, nhãn, thông tin phân công và lịch sử chuyển cho nhân viên.
- Bản nháp và bản tóm tắt nhu cầu do AI tạo, nếu đã bật AI.
- Bản gốc sự kiện kỹ thuật (webhook) liên quan tới bạn.
- Với người đã kết nối Trang: ID và tên Facebook đã lưu. Mã truy cập của Trang (thuộc về Trang của Dezon) bị xóa khi Trang được ngắt kết nối.

## 6. Những gì có thể được giữ lại

- Một bản ghi tối thiểu về chính yêu cầu xóa (ngày, mã xác nhận, tên Trang), không chứa nội dung tin nhắn. Bản ghi này dùng để chứng minh chúng tôi đã thực hiện yêu cầu.
- Dữ liệu pháp luật buộc phải lưu, ví dụ hóa đơn và hợp đồng nếu bạn đã mua dịch vụ. Những dữ liệu này được lưu ngoài Dezon Inbox.
- Bản sao lưu: tự động ghi đè trong vòng [ĐIỀN: số] ngày. Dữ liệu đã xóa không được khôi phục từ bản sao lưu để dùng lại.
- Bản tạm của sự kiện kỹ thuật trong hàng đợi xử lý của hệ thống: tự xóa sau tối đa 7 ngày.

Nếu sau khi xóa bạn nhắn tin lại cho Trang, hệ thống sẽ tạo một cuộc trò chuyện mới.

## 7. Dữ liệu do Meta lưu

Dezon chỉ xóa được dữ liệu trong Dezon Inbox. Tin nhắn vẫn còn trong Messenger của bạn và trong hộp thư Trang trên hệ thống của Meta. Dezon không xóa được dữ liệu do Meta lưu. Bạn có thể xóa cuộc trò chuyện ở phía mình trong Messenger, và quản lý dữ liệu Meta lưu theo [Chính sách quyền riêng tư của Meta](https://www.facebook.com/privacy/policy).

## 8. Gỡ quyền truy cập của Dezon Inbox trong Facebook

Phần này dành cho người đã đăng nhập Facebook để kết nối Trang với Dezon Inbox:

1. Mở Facebook, bấm ảnh đại diện, chọn **Cài đặt và quyền riêng tư**, rồi chọn **Cài đặt**.
2. Chọn **Ứng dụng và trang web**. Nếu bạn kết nối qua Facebook Login for Business, chọn **Tích hợp doanh nghiệp**.
3. Tìm **Dezon Inbox** và bấm **Gỡ**.

Tên mục có thể hơi khác tùy phiên bản Facebook. Gỡ ứng dụng sẽ chặn Dezon Inbox truy cập thêm vào tài khoản và Trang của bạn. Để xóa dữ liệu đã lưu, hãy gửi yêu cầu theo mục 3.

Nếu bạn chỉ nhắn tin cho Trang của Dezon, Dezon Inbox sẽ không xuất hiện trong cài đặt Facebook của bạn. Hãy dùng các cách ở mục 3. Nếu không muốn nhận tin từ Trang nữa, bạn có thể chặn tin nhắn của Trang ngay trong Messenger.

## 9. Liên hệ

[ĐIỀN: tên pháp lý công ty]. Địa chỉ: [ĐIỀN: địa chỉ trụ sở]. Email: [support@dezon.vn](mailto:support@dezon.vn). Điện thoại: [ĐIỀN: số điện thoại].

<!-- LANG:en -->

# Dezon Inbox Data Deletion Instructions

Last updated: 5 November 2026

Dezon Inbox is internal inbox software. Staff of [ĐIỀN: company legal name] ("Dezon") use it to reply to messages sent to Dezon's Facebook Pages. This page explains how to ask Dezon to delete your data from Dezon Inbox. Full details of how we handle data are in our [Privacy Policy](https://dezon.vn/chinh-sach-quyen-rieng-tu).

## 1. Who can ask for deletion

- Anyone who has messaged a Dezon Facebook Page.
- Staff members or Page admins who logged in with Facebook to connect a Page to Dezon Inbox.

Deletion requests are **free of charge**.

## 2. What Dezon Inbox stores about you

- Your Facebook display name and profile picture.
- The Page-scoped ID (PSID) assigned by Meta.
- Messages exchanged with Dezon's Page, and attachments (photos, videos, files...).
- Information you gave in the chat, such as a phone number or email.
- Notes and tags that Dezon staff added to the conversation.
- For people who connected a Page: app-scoped user ID and Facebook name. Your Facebook login token is not stored.

## 3. How to make a request

**Option 1: Message the Page (fastest).** Open the Dezon Facebook Page you messaged before and send: **XÓA DỮ LIỆU** (or "DELETE MY DATA"). We can identify your account immediately, so you do not need to provide anything else.

**Option 2: Email** [support@dezon.vn](mailto:support@dezon.vn) with the subject **"Data deletion request"** and include:

- your Facebook name;
- the name of the Dezon Page you messaged;
- roughly when you messaged it;
- optional: a screenshot of the conversation or a link to your Facebook profile;
- the email or channel where you want to receive confirmation.

**Option 3: Web form:** [ĐIỀN: form link, remove this line if there is none]

Please do **not** send ID cards or identity documents. We do not need them.

## 4. What happens next

1. We confirm that we received your request. If you used email, we may ask you to send a short code from that same Messenger account, to make sure you own it.
2. We delete your data **within 72 hours** of verification.
3. We send a deletion confirmation with a **confirmation code**, by email or Messenger. We then also delete your request and that confirmation message from Dezon Inbox, keeping only the minimal record described in section 6.
4. To check the status, reply to the email or message the Page with your confirmation code. If we cannot delete part of the data, we will explain why.

## 5. What is deleted

- Your contact record: name, profile picture (including the copy in our file storage), and any saved phone number and email.
- All your Page-scoped IDs (PSIDs) on Dezon's Pages.
- All messages in both directions.
- All attachments in our file storage.
- Notes, tags, assignment details and handover history.
- AI drafts and AI summaries of your needs, if AI has been enabled.
- Original technical event payloads (webhooks) about you.
- For people who connected a Page: the stored Facebook ID and name. The Page access token (which belongs to Dezon's Page) is deleted when the Page is disconnected.

## 6. What may be kept

- A minimal record of the deletion request itself (date, confirmation code, Page name), with no message content. It lets us show that we carried out the request.
- Data the law requires us to keep, such as invoices and contracts if you bought a service. These are kept outside Dezon Inbox.
- Backups: overwritten automatically within [ĐIỀN: number] days. Deleted data is never restored from backups for reuse.
- Temporary copies of technical events in our processing queue: removed automatically within 7 days.

If you message the Page again after deletion, the system will start a new conversation.

## 7. Data kept by Meta

Dezon can only delete data in Dezon Inbox. Messages remain in your Messenger and in the Page inbox on Meta's systems, and Dezon cannot delete data stored by Meta. You can delete the conversation on your side in Messenger, and manage the data Meta keeps under the [Meta Privacy Policy](https://www.facebook.com/privacy/policy).

## 8. Removing Dezon Inbox's access in Facebook

This section is for people who logged in with Facebook to connect a Page to Dezon Inbox:

1. Open Facebook, tap your profile picture, choose **Settings & privacy**, then **Settings**.
2. Choose **Apps and websites**. If you connected through Facebook Login for Business, choose **Business integrations**.
3. Find **Dezon Inbox** and tap **Remove**.

Menu names may differ slightly between Facebook versions. Removing the app stops Dezon Inbox from accessing your account and Pages from then on. To delete data already stored, make a request as described in section 3.

If you only messaged a Dezon Page, Dezon Inbox will not appear in your Facebook settings. Use the options in section 3. If you no longer want messages from the Page, you can block the Page's messages in Messenger.

## 9. Contact

[ĐIỀN: company legal name]. Address: [ĐIỀN: registered address]. Email: [support@dezon.vn](mailto:support@dezon.vn). Phone: [ĐIỀN: phone number].
