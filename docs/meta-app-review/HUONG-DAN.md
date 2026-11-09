# Hướng dẫn: Xác minh doanh nghiệp, App Review và chuyển app "Dezon Inbox" sang Chính thức

Dành cho: chủ doanh nghiệp Dezon (không cần biết kỹ thuật).
App: **Dezon Inbox**, App ID `1727184952398550`, loại **Doanh nghiệp (Business)**, hiện ở chế độ **Phát triển**.
Cập nhật: 2026-11-05. Nguồn: tài liệu chính thức của Meta, tổng hợp trong [`research.md`](./research.md).

Các file đi kèm trong cùng thư mục:

- [`QUYEN-VA-MO-TA.md`](./QUYEN-VA-MO-TA.md): nội dung tiếng Anh để dán vào form, mỗi quyền một đoạn.
- [`KICH-BAN-VIDEO.md`](./KICH-BAN-VIDEO.md): kịch bản quay video cho từng quyền.
- [`chinh-sach-quyen-rieng-tu.html`](./chinh-sach-quyen-rieng-tu.html) và [`xoa-du-lieu.html`](./xoa-du-lieu.html): 2 trang đăng lên dezon.vn (bản `.md` cùng tên có ghi chú nội bộ ở đầu file, đọc trước khi đăng).
- [`research.md`](./research.md): bằng chứng và trích dẫn từ Meta (dành cho người kỹ thuật).

Ký hiệu trong tài liệu:

- **[ĐIỀN: ...]**: chỗ bạn phải tự điền. Tìm nhanh bằng Ctrl+F gõ `ĐIỀN`.
- **[Kỹ thuật]**: việc của người lập trình, không phải việc bạn bấm trên Meta.
- **(chưa chắc)**: Meta chưa ghi rõ, hoặc màn hình của bạn có thể khác tài liệu. Làm theo hướng dẫn nhưng để ý.
- Nhãn tiếng Việt trên Meta có thể hơi khác. Nhãn tiếng Anh ghi trong ngoặc để bạn đối chiếu.

---

## Tóm tắt trong 30 giây

1. **Không bỏ qua được App Review.** Khách nhắn Page không có vai trò trong app. Muốn nhận và trả lời tin của họ, app cần **quyền truy cập nâng cao** (Advanced Access). Quyền này chỉ có sau khi **xác minh doanh nghiệp** và **qua App Review**.
2. **Thứ tự:** Xác minh doanh nghiệp → nối app với doanh nghiệp → điền thông tin app → đưa hệ thống lên mạng công khai → gửi App Review → được duyệt → gạt sang **Chính thức**.
3. **Thời gian dự kiến:** khoảng **2 đến 5 tuần**.

> **Việc phải có trước khi gửi App Review (quan trọng nhất):** hệ thống Dezon Inbox phải chạy trên **một địa chỉ web công khai có HTTPS**, ví dụ `https://inbox.dezon.vn`. Hiện hệ thống mới chạy trên máy phát triển. Nhân viên Meta phải tự vào thử được. Nếu họ không vào được, **cả hồ sơ bị từ chối**. [Kỹ thuật] Việc đưa lên máy chủ thuộc Giai đoạn 1D và cần làm xong trước bước C.

Bước A (xác minh doanh nghiệp) mất lâu nhất. **Hãy bắt đầu bước A ngay hôm nay**, làm song song với việc đưa hệ thống lên máy chủ.

---

## A. Xác minh doanh nghiệp (Business Verification)

Mục đích: chứng minh với Meta rằng Dezon là công ty thật. Đây là điều kiện bắt buộc để xin quyền nâng cao.

Lưu ý: việc này **khác** với "Meta Verified". Xác minh doanh nghiệp **không** cho dấu tích xanh.

### A1. Chuẩn bị giấy tờ (trước khi bấm)

1. **Giấy chứng nhận đăng ký doanh nghiệp** (bản scan hoặc ảnh chụp rõ, còn hiệu lực).
   - Meta chấp nhận tiếng Việt, không cần dịch.
   - Giấy này chứng minh tên pháp lý, địa chỉ và mã số doanh nghiệp.
2. Chỉ khi cần chứng minh riêng số điện thoại hoặc địa chỉ: thêm **hóa đơn điện/nước/internet** hoặc **sao kê ngân hàng doanh nghiệp**. Trên đó phải có tên công ty.
   - Hóa đơn tiện ích **không** dùng để chứng minh tên công ty, chỉ dùng cho địa chỉ và số điện thoại.
   - Giấy tờ thuế tự khai **không** được chấp nhận.
3. **Che** các số giấy tờ cá nhân không cần thiết trên bản scan (ví dụ số CCCD của người đại diện).
4. Ghi sẵn các thông tin sau, **chép đúng từng chữ theo giấy phép**:

| Thông tin             | Giá trị                                                               |
| --------------------- | --------------------------------------------------------------------- |
| Tên pháp lý công ty   | [ĐIỀN: tên pháp lý công ty, đúng như trên giấy phép, kể cả "CÔNG TY TNHH/CỔ PHẦN ..."] |
| Mã số doanh nghiệp    | [ĐIỀN: mã số doanh nghiệp]                                             |
| Địa chỉ trụ sở        | [ĐIỀN: địa chỉ đúng như trên giấy phép]                                |
| Số điện thoại công ty | [ĐIỀN: số điện thoại công ty]                                          |
| Website               | `https://dezon.vn`                                                     |
| Email nhận mã         | [ĐIỀN: email tên miền @dezon.vn, ví dụ support@dezon.vn (xác nhận lại)] |

5. Kiểm tra website `https://dezon.vn`:
   - Mở được, có ổ khóa HTTPS.
   - Không có link hỏng dẫn tới trang lỗi.
   - Nên có tên công ty, địa chỉ hoặc số điện thoại khớp giấy phép (ví dụ ở chân trang hoặc trang Liên hệ).

### A2. Xác minh tên miền dezon.vn (nên làm, giúp xác minh nhanh)

Nếu chọn nhận mã qua email, Meta có thể đòi chứng minh bạn sở hữu tên miền. Làm trước cho chắc.

1. Vào **Meta Business Suite** → **Cài đặt** (Settings) → mục **An toàn thương hiệu** (Brand safety) → **Tên miền** (Domains).
2. Bấm thêm, nhập `dezon.vn` (không có `https://`, không có `www`).
3. Chọn một trong 3 cách Meta đưa ra:
   - **Bản ghi DNS TXT** (khuyên dùng, không phải sửa website): gửi đoạn mã cho người quản lý tên miền thêm vào.
   - Thẻ meta trong trang chủ.
   - Tải file HTML lên thư mục gốc của website.
4. Bấm **Xác minh**. Sau khi xác minh xong, có thể gỡ đoạn mã mà không ảnh hưởng.

Cần: bạn có toàn quyền trên tài khoản doanh nghiệp (business portfolio), và có người quản trị tên miền dezon.vn.

### A3. Gửi xác minh

1. Vào **Meta Business Suite** → **Trung tâm bảo mật** (Security Center).
   - Không thấy mục này: có thể bạn chưa có toàn quyền trên tài khoản doanh nghiệp. Nhờ người đang là quản trị viên cấp quyền.
2. Bấm **Bắt đầu xác minh** (Start verification).
3. Nhập tên pháp lý, địa chỉ, số điện thoại, website. **Phải khớp giấy phép.**
4. Meta tìm hồ sơ công ty. Nếu không thấy, chọn **"Doanh nghiệp của tôi không có trong danh sách"** (My business isn't listed) rồi tải giấy chứng nhận đăng ký doanh nghiệp lên.
5. Chọn cách nhận mã: email, điện thoại, tin nhắn, WhatsApp, hoặc xác minh tên miền. Khuyên dùng **email @dezon.vn** (đã xác minh tên miền ở A2).
6. Nhập mã, bấm **Xong**.
7. Chờ kết quả: **tối đa 14 ngày làm việc**.

Nếu thấy dòng **"Không đủ điều kiện xác minh"** (Ineligible for verification): bạn chưa cần xác minh ở đây. Meta sẽ báo ở chỗ khác khi cần.

### A4. Tránh bị từ chối

- Không sửa thông tin doanh nghiệp sau khi gửi. **Sửa là phải xác minh lại từ đầu.**
- Tên, địa chỉ, số điện thoại phải khớp đúng giấy phép. Thông tin sai lệch hoặc gây hiểu nhầm là một lý do Meta nêu khi từ chối.
- Website không mở được, không có HTTPS, hoặc có link lỗi cũng bị từ chối.
- Bị từ chối vẫn có thể **kháng nghị** (appeal).

### A5. Nối app với doanh nghiệp

Làm được ngay, không cần chờ xác minh xong.

1. Vào [developers.facebook.com](https://developers.facebook.com) → **Ứng dụng của tôi** → **Dezon Inbox**.
2. **Cài đặt ứng dụng → Thông tin cơ bản** → kéo xuống mục **Xác minh** (Verification). (Nhãn tiếng Việt chưa chắc.)
3. Chọn tài khoản doanh nghiệp (business portfolio) của Dezon để nối app.
4. Khi xác minh ở A3 xong, quay lại đây. Mục này phải báo app **đã nối với doanh nghiệp đã xác minh**.

Lưu ý sau khi nối:

- Vai trò trong app (admin, tester...) sẽ quản lý trong **Business Manager**, không còn ở "Vai trò trong ứng dụng".
- Doanh nghiệp đã xác minh được thêm tới **500 người thử** (chưa xác minh: 50).

---

## B. Điền thông tin app (Cài đặt ứng dụng → Thông tin cơ bản)

Vào **Ứng dụng của tôi → Dezon Inbox → Cài đặt ứng dụng → Thông tin cơ bản**. Điền đủ các ô dưới đây rồi bấm **Lưu thay đổi**.

### B1. Đăng 3 trang lên dezon.vn trước

Ba trang này phải mở được công khai, có HTTPS, không chặn theo quốc gia, không bắt đăng nhập.

| Trang                       | Địa chỉ gợi ý                                   | Nội dung                                                                 |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| Chính sách quyền riêng tư   | [ĐIỀN: ví dụ https://dezon.vn/chinh-sach-quyen-rieng-tu] | Dữ liệu thu thập, mục đích, nơi lưu, thời gian giữ, cách yêu cầu xóa      |
| Hướng dẫn xóa dữ liệu       | [ĐIỀN: ví dụ https://dezon.vn/xoa-du-lieu]       | Cách khách yêu cầu xóa, cần cung cấp gì, bao lâu xử lý                    |
| Điều khoản dịch vụ          | [ĐIỀN: ví dụ https://dezon.vn/dieu-khoan]        | Điều khoản ngắn. Tài liệu Meta ghi là bắt buộc để Chính thức (thực tế đôi khi không đòi), cứ làm cho chắc. **Bộ hồ sơ này chưa soạn sẵn trang này.** |

Mẹo:

- Viết tiếng Việt **kèm bản tiếng Anh** trên cùng trang. Nhân viên Meta đọc tiếng Anh.
- Dùng cùng tên miền `dezon.vn` với app. Tên miền khác nhau dễ bị hỏi lại.
- Nội dung phải phù hợp **Nghị định 13/2023/NĐ-CP** về bảo vệ dữ liệu cá nhân. Nên nhờ luật sư Việt Nam xem lại. Meta không kiểm tra phần này thay bạn.
- Nên ghi trung thực rằng sau này hệ thống sẽ có **AI tự trả lời** (có chuyển sang người thật). Hoặc cập nhật chính sách khi tính năng đó ra mắt.
- Chính sách phải nói rõ: Dezon lưu tên, ảnh đại diện, mã định danh Messenger (PSID), tin nhắn và tệp đính kèm, ghi chú và nhãn của nhân viên; lưu trên máy chủ ở [ĐIỀN: Việt Nam hoặc Singapore]. Trang soạn sẵn đã có đủ các ý này.
- Chỉ ghi những gì hệ thống **đang làm thật**. Ví dụ: việc tự xóa dữ liệu thô từ webhook sau 90 ngày **mới là kế hoạch** (chưa làm), nên trang soạn sẵn ghi là "đang thiết lập". Khi đội kỹ thuật làm xong thì sửa lại câu đó.
- Nếu đăng bằng cách tải file `.html` lên (đường dẫn có đuôi `.html`), phải sửa các link chéo giữa 2 trang cho đúng. Xem ghi chú đầu file `.md`.

### B2. Các ô cần điền

| Ô trên Meta (tiếng Anh)           | Điền gì                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tên hiển thị (Display Name)       | `Dezon Inbox`. Không dùng chữ "Facebook", "FB", "Messenger" trong tên.                                      |
| Email liên hệ (Contact Email)     | [ĐIỀN: support@dezon.vn (xác nhận lại)]. Phải là hộp thư có người đọc, Meta gửi thông báo về đây.            |
| URL chính sách quyền riêng tư (Privacy Policy URL) | Địa chỉ trang Chính sách ở B1.                                                              |
| URL điều khoản dịch vụ (Terms of Service URL) | Địa chỉ trang Điều khoản ở B1.                                                                   |
| Xóa dữ liệu người dùng (User Data Deletion) | Chọn loại **"URL hướng dẫn xóa dữ liệu"** (Data Deletion Instructions URL), dán địa chỉ trang Xóa dữ liệu ở B1. Không cần chọn "URL gọi lại" (callback). |
| Biểu tượng ứng dụng (App Icon)    | Ảnh vuông **1024 × 1024** px, logo Dezon. **Không** được có logo Facebook hay Messenger.                     |
| Hạng mục (Category)               | Meta không quy định phải chọn mục nào. Chọn mục gần nhất về kinh doanh hoặc nhắn tin, ví dụ **Business and Pages** nếu có trong danh sách. (chưa chắc: tên các mục chưa được đối chiếu) |
| Mục đích ứng dụng (App Purpose)   | Chọn mục **"Yourself or your own business"** (tiếng Việt kiểu "Bản thân hoặc doanh nghiệp của bạn", nhãn chưa chắc), vì chỉ nhân viên Dezon đăng nhập. (Đây là đề xuất, Meta không ghi riêng cho trường hợp này.) |
| Nền tảng (Platform)               | Bấm **+ Thêm nền tảng** → **Trang web** (Website) → Site URL: [ĐIỀN: https://inbox.dezon.vn, sau khi đã đưa hệ thống lên]. |
| Xác minh (Verification)           | Nối với tài khoản doanh nghiệp Dezon (xem A5).                                                               |

Vì sao chọn "URL hướng dẫn" mà không cần "callback":
khách chỉ nhắn Page, họ không đăng nhập app, nên Meta không gửi yêu cầu xóa tự động cho khách. Khách cần một trang hướng dẫn công khai để yêu cầu xóa. Callback có thể làm sau, chỉ áp dụng cho nhân viên đăng nhập bằng Facebook.

---

## C. Xin quyền nâng cao (App Review)

### C0. Điều kiện trước khi bấm gửi

Kiểm tra đủ các mục sau. Thiếu một mục là dễ bị từ chối cả hồ sơ.

1. Bước A đã xong (doanh nghiệp đã xác minh) và app đã nối với doanh nghiệp.
2. Bước B đã điền đủ và đã lưu.
3. Hệ thống chạy trên **địa chỉ HTTPS công khai** (ví dụ `https://inbox.dezon.vn`), chứng chỉ hợp lệ, không chặn IP, không cần VPN. [Kỹ thuật]
4. Webhook trên Meta đã trỏ về máy chủ thật (không còn là máy phát triển) và hoạt động. [Kỹ thuật]
5. Bật thêm trường webhook **`messaging_policy_enforcement`** (Meta báo vi phạm chính sách qua đây). Hiện app **chưa** đăng ký trường này. [Kỹ thuật]
6. Page dùng để demo đã **được xuất bản** (công khai, không ẩn).
7. **Mỗi quyền định xin đã được dùng thành công ít nhất 1 lần trong 30 ngày gần nhất.**
   - Nút **"Nhận quyền truy cập nâng cao"** sẽ **mờ, không bấm được** cho tới khi Meta ghi nhận lần dùng đó.
   - Meta cần **tối đa 2 ngày** để ghi nhận.
   - Cách làm: một người có vai trò trong app kết nối Page, nhận và trả lời vài tin, bấm "Đồng bộ lịch sử", mở hội thoại có tên và ảnh khách. Nếu muốn xin Human Agent: nhờ kỹ thuật bật `META_HUMAN_AGENT_ENABLED=true`, rồi trả lời một hội thoại đã quá 24 giờ (hệ thống tự gắn tag `HUMAN_AGENT`). Chưa chắc tag này gửi được trước khi Meta duyệt; nếu báo lỗi thì bỏ Human Agent khỏi lần gửi này.
   - **[Kỹ thuật]** Hiện lúc kết nối Facebook, hệ thống chỉ xin `pages_show_list`, `pages_manage_metadata`, `pages_messaging`. Phải **thêm `pages_read_engagement`** (vào danh sách quyền trong code, hoặc vào cấu hình Facebook Login for Business nếu dùng `config_id`). Nếu không, Meta không ghi nhận lần dùng quyền này và hộp thoại Facebook trong video cũng không hiện quyền này.
8. Hệ thống đã **xong, chạy ổn định**. Meta từ chối app "còn đang phát triển dở".
9. Video cho từng quyền đã quay xong theo [`KICH-BAN-VIDEO.md`](./KICH-BAN-VIDEO.md).

### C1. Xin những quyền nào

Chỉ xin những gì hệ thống **đang dùng thật**. Xin thừa là lý do bị từ chối phổ biến.

| # | Quyền / tính năng                              | Dùng để làm gì                                       | Mức độ                                      |
| - | ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| 1 | `pages_messaging`                              | Nhận và trả lời tin nhắn Page                        | **Bắt buộc**                                |
| 2 | `pages_manage_metadata`                        | Đăng ký nhận tin (webhook) cho Page                  | **Bắt buộc** (đi kèm `pages_messaging`)      |
| 3 | `pages_show_list`                              | Hiện danh sách Page để chọn khi kết nối              | **Bắt buộc** (đi kèm `pages_messaging`)      |
| 4 | `pages_read_engagement`                        | Đọc lịch sử hội thoại (nút "Đồng bộ lịch sử")        | Nên xin (xem lưu ý dưới)                     |
| 5 | Business Asset User Profile Access (tính năng) | Đọc **tên và ảnh đại diện** khách                    | **Bắt buộc** để thấy tên và ảnh (không có thì chỉ thấy mã số) |
| 6 | Human Agent (tính năng)                        | Nhân viên trả lời trong **7 ngày** thay vì 24 giờ    | Tùy chọn, nên xin                            |
| 7 | `public_profile`                               | Bắt buộc với app dùng "Facebook Login for Business"  | **Bắt buộc trước khi Chính thức**            |

**Không xin:** `business_management` (trừ khi sau này chứng minh được là cần), bất kỳ quyền quảng cáo, Instagram, hay tính năng AI nào.

Lưu ý:

- **`pages_read_engagement`:** Meta yêu cầu quyền này cho việc đọc hội thoại, nhưng mẫu video của Meta lại nói về bài đăng. Nhân viên duyệt có thể hỏi lại. Nếu bị từ chối riêng quyền này, hệ thống vẫn nhận và trả lời tin bình thường, chỉ mất phần đồng bộ tin cũ.
- **`public_profile`:** chưa rõ là bấm một lần là có, hay phải quay video (chưa chắc). Nếu màn hình cho bấm nhận ngay thì bấm. Nếu không, gửi chung trong hồ sơ.
- **Human Agent:** chỉ dùng cho tin do **người thật** gõ. Không bao giờ dùng cho tin tự động hay AI.

### C2. Các bước bấm trên Meta

1. Vào **Ứng dụng của tôi → Dezon Inbox → Xét duyệt ứng dụng → Quyền và tính năng** (Permissions and Features).
2. Tìm từng quyền ở bảng C1, bấm **Nhận quyền truy cập nâng cao** (Request advanced access). Nên làm theo thứ tự 1 → 7.
3. Nếu Meta nhắc **Xác minh doanh nghiệp**: làm theo bước A.
4. **Trả lời câu hỏi xử lý dữ liệu** (Data Handling Questions). Chuẩn bị sẵn câu trả lời:
   - Bên xử lý dữ liệu cho Dezon: nhà cung cấp máy chủ [ĐIỀN: tên nhà cung cấp VPS], nhà cung cấp lưu trữ tệp [ĐIỀN: tên dịch vụ lưu trữ S3]. Nhà cung cấp AI chỉ thêm khi tính năng AI ra mắt.
   - Nơi lưu dữ liệu: [ĐIỀN: Việt Nam hoặc Singapore].
   - Token của Page được **mã hóa** khi lưu.
   - Chỉ nhân viên Dezon đăng nhập được, có phân quyền admin/nhân viên.
   - Thời gian giữ dữ liệu và cách xóa: xem bảng "Phần trả lời về dữ liệu" trong [`QUYEN-VA-MO-TA.md`](./QUYEN-VA-MO-TA.md). Lưu ý: việc tự xóa dữ liệu thô sau 90 ngày và chức năng xóa dữ liệu một khách **chưa làm xong**. Chỉ khai là "có" khi đội kỹ thuật xác nhận đã chạy, hoặc khi đã có người xóa thủ công được.
   - Chính sách khi cơ quan nhà nước yêu cầu cung cấp dữ liệu: [ĐIỀN: chính sách của Dezon, nên hỏi luật sư].
   - Nên hỏi ý kiến người phụ trách pháp lý trước khi trả lời. Meta chấm câu trả lời ngay lập tức.
5. **Hoàn tất cài đặt ứng dụng** (Complete App Settings): kiểm lại biểu tượng, URL chính sách, mục đích, hạng mục, email liên hệ (đã làm ở B).
6. **Hướng dẫn truy cập để thử app** (App Verification): dán khối "Hướng dẫn cho người duyệt" trong [`QUYEN-VA-MO-TA.md`](./QUYEN-VA-MO-TA.md), sau khi chuẩn bị đủ các mục ở C3.
7. **Mô tả cách dùng từng quyền** (Usage Descriptions):
   - Dán mô tả tiếng Anh từ [`QUYEN-VA-MO-TA.md`](./QUYEN-VA-MO-TA.md), **mỗi quyền một đoạn riêng**. Meta cấm chép y nguyên một đoạn cho nhiều quyền.
   - Với `pages_show_list` và `pages_manage_metadata`: ghi rõ là quyền đi kèm `pages_messaging`.
   - Mẫu của Meta cho `pages_messaging` có câu hỏi về "quảng cáo". Đó là lỗi của Meta. Cứ trả lời theo việc nhắn tin.
   - Tải lên **video riêng cho từng quyền** theo [`KICH-BAN-VIDEO.md`](./KICH-BAN-VIDEO.md).
8. **Gửi xét duyệt** (Submit for Review): đồng ý điều khoản, bấm gửi.
9. **Sau khi gửi: không sửa gì trong Cài đặt ứng dụng.** Sửa có thể phải duyệt lại.

### C3. Cho nhân viên Meta vào thử (rất quan trọng)

Meta tự thử app bằng tài khoản của họ. Không vào được là **từ chối cả hồ sơ**.

Chuẩn bị:

1. **Địa chỉ hệ thống:** [ĐIỀN: https://inbox.dezon.vn]. Mở được từ nước ngoài, không cần VPN.
2. **Tài khoản nhân viên thử** trong Dezon Inbox, chỉ dùng cho Meta:
   - Email: [ĐIỀN: ví dụ meta-review@dezon.vn]
   - Mật khẩu: [ĐIỀN: mật khẩu riêng, đổi sau khi duyệt xong]
   - Vai trò: **admin**, để vào được trang **Kênh** (Admin → Channels) và thấy nút **Kết nối → Facebook**.
3. **Page demo đã kết nối sẵn:** [ĐIỀN: tên Page demo, ví dụ "Demo app"] và link nhắn tin `https://m.me/[ĐIỀN: tên người dùng của Page]`.
4. **Không** đưa mật khẩu Facebook cá nhân của bạn. **Không** tạo tài khoản Facebook giả. Meta tự thử bằng tài khoản của họ; tài khoản giả khiến cả hồ sơ bị từ chối.
5. **[CẦN QUYẾT ĐỊNH]** Tài khoản admin thấy hội thoại của **mọi** Page đã kết nối, gồm cả khách thật. Hỏi đội kỹ thuật có nên tạm ngắt các Page khác trong lúc Meta duyệt không.

Đoạn hướng dẫn tiếng Anh để dán vào ô hướng dẫn: dùng khối **"Hướng dẫn cho người duyệt"** trong [`QUYEN-VA-MO-TA.md`](./QUYEN-VA-MO-TA.md) (chỉ dùng một bản đó, để không lệch nội dung). Khối đó đã dịch từng nút tiếng Việt và giải thích vì sao tin nhắn thử của Meta có thể chưa về trước khi được duyệt.

### C4. Mẹo quay video để không bị từ chối

Chi tiết từng cảnh ở [`KICH-BAN-VIDEO.md`](./KICH-BAN-VIDEO.md). Những điểm Meta hay bắt lỗi:

1. Bắt đầu từ lúc **chưa đăng nhập**, quay toàn bộ quá trình đăng nhập.
2. Quay cảnh bấm **Kết nối → Facebook**, hộp thoại Facebook hiện ra, chọn Page và **cấp quyền**.
3. Gửi tin phải là **cảnh thật** trong hệ thống, rồi quay **Messenger của khách nhận được tin** (điện thoại hoặc web). Không dùng ảnh chụp màn hình.
4. Giao diện đang là tiếng Việt: **thêm phụ đề tiếng Anh** giải thích từng nút và từng bước.
5. Độ phân giải 1080p trở lên. Đặt màn hình rộng tối đa 1440 px cho chữ to. Phóng to con trỏ chuột.
6. **Không cần âm thanh**, Meta không nghe.
7. Mỗi video ngắn, khoảng 2 đến 5 phút, định dạng MP4. (Meta không công bố giới hạn, đây là đề xuất an toàn.)
8. Che mật khẩu và dữ liệu khách thật nếu có trong khung hình. Nên dùng tài khoản người thử là nhân viên Dezon để nhắn.

### C5. Chờ kết quả

- Thường **2 đến 7 ngày** (Meta ghi: thường dưới 1 tuần, nhiều khi 2 đến 3 ngày). Xem kết quả trong **Xét duyệt ứng dụng**, và để ý email liên hệ.
- Bị từ chối một phần: đọc lý do, sửa đúng chỗ đó, gửi lại phần bị từ chối.

---

## D. Sau khi được duyệt: chuyển sang Chính thức

### D1. Trước khi gạt

1. Vào **Xét duyệt ứng dụng → Quyền và tính năng**. Các quyền ở C1 phải hiện **Quyền truy cập nâng cao** (Advanced Access).
2. Nếu Meta yêu cầu **Kiểm tra sử dụng dữ liệu** (Data Use Checkup), làm xong trước. Meta đòi bước này trước khi chuyển sang Chính thức, và sau đó **mỗi năm một lần**.
3. Kiểm lại B: đủ tên, email, biểu tượng, hạng mục, mục đích, URL chính sách, URL xóa dữ liệu.

**Đừng gạt sớm.** Ở chế độ Chính thức, chỉ quyền đã được duyệt mới chạy, **kể cả với người có vai trò trong app**. Gạt khi chưa duyệt có thể làm hệ thống ngừng chạy với chính nhân viên.

### D2. Gạt sang Chính thức

1. Ở thanh trên cùng của trang app, tìm **Chế độ của ứng dụng: Phát triển / Chính thức**.
2. Gạt sang **Chính thức**.

Lưu ý (chưa chắc): tài liệu Meta nói app loại Business "không có chế độ", chỉ dựa vào mức quyền. Nhưng màn hình của bạn vẫn có nút gạt. Vì vậy làm cả hai: được duyệt quyền nâng cao, rồi gạt sang Chính thức.

### D3. Kiểm tra ngay sau khi gạt

1. Nhờ một người **không có vai trò trong app** (ví dụ khách quen hoặc tài khoản như Tuấn Kiệt) nhắn vào Page.
2. Tin phải hiện trong hộp thư Dezon Inbox trong vài giây, **có tên và ảnh** khách.
3. Trả lời trong hệ thống. Người đó phải nhận được trên Messenger.
4. Thử với **mỗi Page** đã kết nối. Mỗi Page có màu nhãn riêng.
5. Bấm **Đồng bộ lịch sử** một lần để kéo tin cũ của khách vào hộp thư.
6. Không cần kết nối lại Page. Nếu một Page không nhận tin: vào **Kênh**, xem trạng thái webhook của Page đó, báo người kỹ thuật. [Kỹ thuật] Kiểm tra trên Meta: **Messenger → Cài đặt → Webhook** vẫn đăng ký đủ trường và Page vẫn được đăng ký nhận tin.

### D4. Việc định kỳ sau khi Chính thức

- **Mỗi năm:** làm Kiểm tra sử dụng dữ liệu (Data Use Checkup) khi Meta nhắc. Bỏ qua có thể bị khóa quyền.
- **Nếu một Page không dùng 90 ngày:** quyền có thể hết hạn. Kết nối lại Page đó.
- **Khi thêm tính năng AI tự trả lời:** cập nhật Chính sách quyền riêng tư, và hệ thống phải cho khách biết họ đang nói chuyện với trợ lý tự động khi luật yêu cầu (Meta khuyến nghị luôn làm).
- **Khi đổi thông tin doanh nghiệp** (tên, địa chỉ): phải xác minh doanh nghiệp lại.

---

## E. Trong lúc chờ: hệ thống vẫn chạy thế nào

Ở chế độ **Phát triển**:

- Hệ thống nhận và trả lời tin **chỉ của người có vai trò trong app** (quản trị viên, nhà phát triển, người thử).
- Tin của khách (người không có vai trò) **chưa** về qua webhook. Đây đúng là điều tài liệu Meta mô tả.
- Nút **Đồng bộ lịch sử** hiện vẫn kéo được tin cũ của khách. Đây là hành vi Meta **không cam kết** (tài liệu nói phải có quyền nâng cao), có thể bị chặn bất cứ lúc nào. Đừng dựa vào nó.

Thêm người thử:

1. Vào **Vai trò trong ứng dụng → Vai trò** → **Thêm người** → chọn **Người dùng thử** (Tester). Sau khi nối app với doanh nghiệp (A5), việc này làm trong **Business Manager**.
2. Người đó phải **chấp nhận lời mời** trong tài khoản Facebook của họ (thường ở developers.facebook.com/requests; tên mục chưa chắc).
3. Từ đó tin họ nhắn vào Page sẽ về hệ thống và trả lời được.

Quy định của Meta về người thử:

- Chỉ thêm **nhân viên Dezon**, hoặc người có **thỏa thuận** làm người thử cho Dezon.
- **Không** thêm khách hàng thật để "lách" App Review. Làm vậy vi phạm quy định của Meta.
- Giới hạn: 50 người (500 người khi doanh nghiệp đã xác minh).

---

## F. Bảng kiểm tra và thời gian dự kiến

### F1. Bảng kiểm tra

| #  | Việc                                                             | Ai làm      | Xong |
| -- | ---------------------------------------------------------------- | ----------- | ---- |
| 1  | Chuẩn bị giấy chứng nhận đăng ký doanh nghiệp, điền bảng A1       | Chủ DN      | [ ]  |
| 2  | Website dezon.vn mở được, HTTPS, không link lỗi, có thông tin công ty | Chủ DN  | [ ]  |
| 3  | Xác minh tên miền dezon.vn (A2)                                   | Chủ DN + quản trị tên miền | [ ] |
| 4  | Gửi Xác minh doanh nghiệp trong Trung tâm bảo mật (A3)            | Chủ DN      | [ ]  |
| 5  | Nối app Dezon Inbox với tài khoản doanh nghiệp (A5)               | Chủ DN      | [ ]  |
| 6  | Đăng 3 trang: Chính sách, Xóa dữ liệu, Điều khoản (B1); nhờ luật sư xem | Chủ DN | [ ] |
| 7  | Điền Thông tin cơ bản: tên, email, URL, biểu tượng 1024×1024, hạng mục, mục đích, nền tảng (B2) | Chủ DN | [ ] |
| 8  | Đưa hệ thống lên `https://inbox.dezon.vn` (HTTPS công khai)       | Kỹ thuật    | [ ]  |
| 9  | Trỏ webhook về máy chủ thật, bật thêm `messaging_policy_enforcement`, thêm `pages_read_engagement` vào quyền xin khi kết nối | Kỹ thuật | [ ]  |
| 10 | Page demo đã xuất bản và đã kết nối                              | Chủ DN      | [ ]  |
| 11 | Dùng thử mỗi quyền ít nhất 1 lần (C0 mục 7), chờ 2 ngày để nút sáng | Chủ DN + Kỹ thuật | [ ] |
| 12 | Tạo tài khoản nhân viên thử cho Meta (C3)                         | Kỹ thuật    | [ ]  |
| 13 | Quay video từng quyền, có phụ đề tiếng Anh (KICH-BAN-VIDEO.md)    | Chủ DN      | [ ]  |
| 14 | Trả lời câu hỏi xử lý dữ liệu (C2 mục 4)                          | Chủ DN      | [ ]  |
| 15 | Dán mô tả từng quyền (QUYEN-VA-MO-TA.md), tải video, gửi xét duyệt | Chủ DN     | [ ]  |
| 16 | Được duyệt: kiểm tra quyền nâng cao, làm Data Use Checkup nếu có  | Chủ DN      | [ ]  |
| 17 | Gạt sang **Chính thức**                                           | Chủ DN      | [ ]  |
| 18 | Thử với người không có vai trò: nhận tin, có tên/ảnh, trả lời được, mọi Page (D3) | Chủ DN | [ ] |
| 19 | Đổi mật khẩu tài khoản thử của Meta                              | Kỹ thuật    | [ ]  |

### F2. Thời gian dự kiến

| Giai đoạn                                   | Thời gian                         |
| ------------------------------------------- | --------------------------------- |
| Xác minh doanh nghiệp                       | Vài ngày đến **14 ngày làm việc** |
| Đưa hệ thống lên máy chủ, đăng 3 trang (song song) | Tùy tiến độ kỹ thuật        |
| Meta ghi nhận lần dùng thử mỗi quyền        | Tối đa 2 ngày                     |
| Meta xét duyệt hồ sơ                        | Thường 2 đến 7 ngày               |
| Nếu bị từ chối và gửi lại                   | Thêm khoảng 1 tuần mỗi lần        |
| **Tổng**                                    | **Khoảng 2 đến 5 tuần**           |

### F3. Mười lỗi hay khiến bị từ chối (tóm tắt)

1. Meta không vào được hệ thống (không có địa chỉ công khai, sai mật khẩu, chặn IP).
2. Thiếu video cho một quyền.
3. Video dùng ảnh chụp thay vì cảnh gửi tin thật, hoặc không quay Messenger nhận tin.
4. Giao diện tiếng Việt mà không có phụ đề tiếng Anh.
5. Không quay từ lúc chưa đăng nhập, hoặc không thấy bước đăng nhập Facebook.
6. Xin quyền chưa dùng tới.
7. Chép cùng một đoạn mô tả cho nhiều quyền.
8. Trang Chính sách quyền riêng tư không mở được, hoặc khác tên miền.
9. App trông như còn dở dang.
10. Dùng tài khoản Facebook giả, hoặc đưa mật khẩu Facebook cá nhân.
