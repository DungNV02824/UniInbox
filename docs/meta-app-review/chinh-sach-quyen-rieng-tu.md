# [GHI CHÚ NỘI BỘ: không đăng phần này]

**Dán URL này vào trường nào của Meta:**

- Cài đặt ứng dụng → Thông tin cơ bản → trường **"URL chính sách quyền riêng tư"** (tiếng Anh: Settings → Basic → **Privacy Policy URL**).
- Tên trường tiếng Việt chưa được đối chiếu với giao diện thật. Nếu khác, tìm ô có chữ "quyền riêng tư" / "Privacy Policy".
- URL gợi ý: `https://dezon.vn/chinh-sach-quyen-rieng-tu`. Trang phải nằm trên tên miền dezon.vn, dùng HTTPS, ai cũng mở được (không cần đăng nhập, không chặn theo quốc gia, không bị bảng cookie che hết nội dung).

**Việc phải làm trước khi đăng:**

1. Tìm và điền mọi chỗ `[ĐIỀN: ...]`, cả bản tiếng Việt và tiếng Anh. Xóa các dòng không áp dụng.
2. Xác nhận lại email `support@dezon.vn`. Email này phải có người đọc hằng ngày.
3. Nhờ luật sư rà soát. Bản này viết theo Nghị định 13/2023/NĐ-CP như yêu cầu. Lưu ý (**cần kiểm tra lại**, không có trong research): **Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 có hiệu lực từ 01/01/2026**, nên có thể có văn bản mới thay thế hoặc bổ sung Nghị định 13. Luật sư cần chốt: tên văn bản áp dụng, cơ sở pháp lý "đồng ý" khi khách tự nhắn tin, thời hạn trả lời yêu cầu, thủ tục chuyển dữ liệu ra nước ngoài (nếu máy chủ ở Singapore hoặc khi dùng AI).
4. Chính sách chỉ được viết đúng những gì hệ thống **thật sự làm** lúc đăng. Đã đối chiếu với code ngày 05/11/2026:
   - **Đúng với code:** mã truy cập Trang mã hóa AES-256-GCM, không trả về trình duyệt, không ghi log; mật khẩu nhân viên lưu dạng băm; token người dùng Facebook không được lưu (chỉ lưu ID và tên Facebook của người kết nối); ngắt kết nối Trang thì xóa mã truy cập; ảnh đại diện khách được lưu bản sao trong kho tệp; phân quyền admin / nhân viên.
   - **Chưa làm, đã viết câu chữ cho đúng:** tự xóa bản gốc webhook sau 90 ngày (job thuộc Giai đoạn 1D, chưa làm). Mục 7 ghi là "đang thiết lập". Khi job chạy thật, sửa thành "tự động xóa sau 90 ngày" ở cả 2 ngôn ngữ, cả file .md và .html.
   - **Chưa làm, chính sách vẫn hứa:** xóa toàn bộ dữ liệu một khách theo yêu cầu trong 72 giờ (đặc tả mục 11, chưa có chức năng). Trước khi đăng phải có người kỹ thuật xóa thủ công được trong 72 giờ (xóa khách trong cơ sở dữ liệu sẽ xóa kèm danh tính, hội thoại, tin nhắn; **tệp đính kèm và ảnh đại diện trong kho tệp phải xóa riêng**).
   - **Chỉ đúng sau khi lên máy chủ:** "mọi kết nối đều mã hóa bằng HTTPS" và "dữ liệu được sao lưu". Sao lưu hằng ngày thuộc Giai đoạn 1D, chưa làm. Điền tần suất sao lưu và số ngày giữ bản sao lưu theo thực tế (đặc tả dự kiến: hằng ngày, giữ 14 bản).
5. Mục 4 (AI): hiện chưa dùng AI. Trước khi bật AI phải cập nhật mục này, ngày cập nhật và tên nhà cung cấp AI. Đặc tả dự kiến dùng Claude API của Anthropic. Hãy xác nhận lại.
6. Mục 8 (chia sẻ): chỉ giữ những nhà cung cấp thật sự dùng (máy chủ, lưu tệp, Sentry, Lark...). Theo Điều khoản nền tảng Meta (§5.a), mỗi nhà cung cấp phải cam kết bằng văn bản rằng họ chỉ xử lý dữ liệu theo chỉ dẫn của Dezon.
7. Thời hạn "72 giờ" ở mục 9 dựa trên cách hiểu về Điều 14 và 16 Nghị định 13, **cần kiểm tra lại** (không có trong research). Luật sư có thể đổi; nếu đổi, phải đổi đồng thời ở trang Xóa dữ liệu.
8. Nên làm thêm: đặt link chính sách vào **lời chào / tin trả lời tự động** của từng Fanpage để khách biết trước khi nhắn.

**Cách đăng lên dezon.vn:** xem `chinh-sach-quyen-rieng-tu.html`.

- **Cách A (WordPress):** tạo Trang mới, đặt đường dẫn (slug) `chinh-sach-quyen-rieng-tu`. Thêm khối **"HTML tùy chỉnh"**. Dán phần nằm giữa `<!-- DEZON-POLICY:START -->` và `<!-- DEZON-POLICY:END -->`.
- **Cách B:** tải cả file .html lên thư mục gốc của website bằng File Manager của hosting. Khi đó URL là `https://dezon.vn/chinh-sach-quyen-rieng-tu.html`.
- Trang này có link cứng tới `https://dezon.vn/xoa-du-lieu` (và trang Xóa dữ liệu có link cứng tới `https://dezon.vn/chinh-sach-quyen-rieng-tu`). Nếu dùng Cách B hoặc đường dẫn khác, sửa các link đó trong cả 2 file cho khớp URL thật (Ctrl+F tìm `dezon.vn/`).
- Dán vào Meta đúng URL mở được. Dùng **cùng một URL** ở Meta, ở trang Xóa dữ liệu và trong `QUYEN-VA-MO-TA.md`.

<!-- PUBLIC:START -->

# Chính sách quyền riêng tư của Dezon Inbox

Cập nhật lần cuối: 05/11/2026

<!-- LANG:vi -->

## 1. Chúng tôi là ai

Dezon Inbox là phần mềm hộp thư nội bộ của [ĐIỀN: tên pháp lý công ty] ("Dezon", "chúng tôi"). Nhân viên Dezon dùng Dezon Inbox để nhận và trả lời, tại một nơi, các tin nhắn khách hàng gửi tới những Trang Facebook (Fanpage) của Dezon qua Messenger.

- Tên pháp lý: [ĐIỀN: tên pháp lý công ty]
- Mã số doanh nghiệp: [ĐIỀN: mã số doanh nghiệp]
- Địa chỉ trụ sở: [ĐIỀN: địa chỉ trụ sở]
- Website: [https://dezon.vn](https://dezon.vn)
- Email về quyền riêng tư: [support@dezon.vn](mailto:support@dezon.vn)
- Điện thoại: [ĐIỀN: số điện thoại]

Với dữ liệu nêu trong chính sách này, Dezon là bên quyết định mục đích và cách xử lý dữ liệu cá nhân (Bên Kiểm soát và xử lý dữ liệu cá nhân theo pháp luật Việt Nam).

Dezon Inbox chỉ dành cho nhân viên Dezon. Đây không phải dịch vụ mở cho công chúng. Chính sách này áp dụng cho:

- **Khách hàng** và bất kỳ ai nhắn tin cho Trang Facebook của Dezon;
- **Nhân viên Dezon** dùng Dezon Inbox, kể cả khi đăng nhập Facebook để kết nối Trang.

Dezon Inbox cũng có thể gom tin từ các kênh khác của Dezon (ví dụ Zalo). Chính sách này mô tả chi tiết dữ liệu nhận từ Facebook và Messenger. Dữ liệu từ các kênh khác được bảo vệ theo cùng các nguyên tắc.

## 2. Dữ liệu chúng tôi xử lý

### 2.1 Khi bạn nhắn tin cho Trang Facebook của Dezon

- **Thông tin hồ sơ do Meta cung cấp:** tên hiển thị và ảnh đại diện trên Facebook của bạn. Chúng tôi lưu một bản sao ảnh đại diện trong kho lưu tệp.
- **Mã định danh theo Trang (PSID):** một dãy số Meta cấp riêng cho bạn trên từng Trang. Đây không phải ID tài khoản Facebook của bạn.
- **Nội dung trò chuyện:** tin bạn gửi và tin Dezon trả lời, thời điểm gửi, trạng thái đã nhận và đã xem.
- **Tệp đính kèm:** ảnh, video, âm thanh, tệp, sticker, và vị trí nếu bạn gửi.
- **Thông tin bạn tự cung cấp trong trò chuyện:** ví dụ số điện thoại, email, địa chỉ, nhu cầu thiết kế, ngân sách.
- **Thông tin ngữ cảnh do Meta gửi kèm:** ví dụ bạn bắt đầu trò chuyện từ quảng cáo, từ liên kết m.me hay từ nút trên Trang, và nút bạn đã bấm.
- **Lịch sử trò chuyện cũ** trong hộp thư Trang. Khi kết nối một Trang, chúng tôi có thể đồng bộ lịch sử này để nhân viên nắm được bối cảnh.
- **Thông tin nhân viên ghi thêm:** ghi chú, nhãn, người phụ trách, trạng thái hội thoại.
- **Dữ liệu kỹ thuật:** bản gốc các sự kiện Meta gửi tới hệ thống (webhook), dùng để xử lý lỗi.

Chúng tôi không yêu cầu dữ liệu cá nhân nhạy cảm. Vui lòng không gửi qua Messenger những thông tin như số căn cước, thông tin thẻ hay tài khoản ngân hàng, hay thông tin sức khỏe. Nếu bạn đã gửi, chúng tôi chỉ dùng thông tin đó cho đúng việc bạn yêu cầu, và bạn có thể yêu cầu xóa.

### 2.2 Thông tin về Trang Facebook

Gồm tên Trang, ID Trang và mã truy cập Trang. Meta cấp các thông tin này khi quản trị viên Trang của Dezon kết nối Trang với Dezon Inbox.

### 2.3 Nhân viên Dezon

- Tên, email công việc, vai trò. Mật khẩu chỉ được lưu dưới dạng mã băm, không lưu nguyên văn.
- Khi bạn kết nối Trang bằng Facebook Login for Business, chúng tôi nhận: ID người dùng theo ứng dụng và tên Facebook của bạn, danh sách Trang bạn quản lý (kèm vai trò của bạn trên từng Trang) và mã truy cập. Mã truy cập người dùng chỉ dùng trong lúc kết nối và không được lưu lại. Chúng tôi chỉ lưu ID và tên Facebook của người đã kết nối, cùng mã truy cập của những Trang được chọn.
- Nhật ký: nhân viên nào đã gửi tin nào, các thay đổi về kênh và thông tin khách, và nhật ký truy cập kỹ thuật (thời điểm, địa chỉ IP, đường dẫn yêu cầu). Nhật ký dùng cho bảo mật và kiểm tra.

## 3. Chúng tôi dùng dữ liệu để làm gì

- Nhận, hiển thị và trả lời tin nhắn của bạn: tư vấn, báo giá, chăm sóc khách hàng, xử lý đơn hàng thiết kế.
- Lưu lịch sử trò chuyện, để nhân viên nào tiếp nhận cũng hiểu bối cảnh và không phải hỏi lại bạn.
- Phối hợp nội bộ: phân công người phụ trách, ghi chú, báo cho nhân viên khi có tin mới.
- Bảo mật hệ thống, phát hiện lỗi, chống lạm dụng, quản lý quyền truy cập của nhân viên.
- Thực hiện nghĩa vụ theo quy định của pháp luật.

Chúng tôi **không bán và không cho thuê** dữ liệu của bạn. Chúng tôi không dùng dữ liệu này để quảng cáo hay lập hồ sơ cho bên thứ ba, và không gửi tin quảng cáo hàng loạt qua Messenger.

## 4. Trí tuệ nhân tạo (AI)

**Hiện tại (05/11/2026), Dezon Inbox chưa dùng AI.** Mọi tin trả lời đều do nhân viên Dezon viết và gửi.

**Dự kiến:** Dezon có kế hoạch thêm trợ lý AI để:

- soạn sẵn gợi ý câu trả lời cho nhân viên duyệt trước khi gửi;
- với một số Trang hoặc kênh do Dezon chọn, tự trả lời các câu hỏi thường gặp (mẫu thiết kế, giá, tình trạng), kể cả ngoài giờ làm việc.

Khi bật AI:

- Nội dung tin nhắn liên quan (chữ và ảnh) cùng bản tóm tắt nhu cầu của khách sẽ được gửi tới nhà cung cấp AI để tạo câu trả lời. Nhà cung cấp: [ĐIỀN: tên nhà cung cấp AI, dự kiến Anthropic (Claude API)]. Máy chủ của nhà cung cấp có thể đặt ở nước ngoài.
- Chúng tôi chỉ gửi phần dữ liệu cần thiết, không bao giờ gửi mã truy cập hay mật khẩu.
- Chúng tôi chỉ dùng nhà cung cấp cam kết bằng hợp đồng rằng họ chỉ xử lý dữ liệu theo chỉ dẫn của Dezon và không dùng dữ liệu đó để huấn luyện mô hình.
- AI có thể lưu một bản tóm tắt nhu cầu của bạn (mẫu quan tâm, ngân sách, phong cách) để lần sau không phải hỏi lại.
- AI chuyển cuộc trò chuyện cho nhân viên khi gặp việc cần người thật (ví dụ hỏi giảm giá, khiếu nại) hoặc khi bạn muốn gặp nhân viên. **Bạn có thể yêu cầu nói chuyện với người thật bất kỳ lúc nào.**
- Tin do AI tự gửi sẽ được ghi rõ là tin tự động khi pháp luật yêu cầu, và theo khuyến nghị của Meta.
- AI không tự quyết định những việc có hệ quả pháp lý hoặc ảnh hưởng đáng kể tới bạn. Giá chốt, giảm giá và hợp đồng luôn do nhân viên quyết định.

Chúng tôi sẽ cập nhật chính sách này, kèm ngày cập nhật, **trước khi** bật AI.

## 5. Cơ sở pháp lý

Chúng tôi xử lý dữ liệu cá nhân theo pháp luật Việt Nam về bảo vệ dữ liệu cá nhân, gồm Nghị định 13/2023/NĐ-CP và [ĐIỀN: văn bản pháp luật khác đang có hiệu lực, luật sư xác nhận].

- **Sự đồng ý của bạn:** khi bạn chủ động nhắn tin và cung cấp thông tin cho Trang của Dezon, bạn đồng ý để Dezon xử lý thông tin đó nhằm trả lời và tư vấn cho bạn, như mô tả trong chính sách này. Với mục đích khác, như AI tự trả lời hay gửi thông tin khuyến mãi, chúng tôi sẽ xin bạn đồng ý riêng khi pháp luật yêu cầu. Bạn có thể rút lại sự đồng ý bất kỳ lúc nào. Việc rút lại không ảnh hưởng tới phần xử lý đã diễn ra trước đó.
- **Thực hiện hợp đồng:** khi bạn đặt dịch vụ, chúng tôi xử lý dữ liệu để thực hiện hợp đồng và nghĩa vụ với bạn.
- **Nghĩa vụ pháp lý:** khi cơ quan nhà nước có thẩm quyền yêu cầu theo quy định của pháp luật.
- **Nhân viên:** theo hợp đồng lao động và quy định nội bộ của Dezon.

## 6. Nơi lưu và bảo mật

**Nơi lưu:** dữ liệu được lưu trong cơ sở dữ liệu và kho lưu tệp trên máy chủ Dezon thuê tại [ĐIỀN: Việt Nam hoặc Singapore, tên nhà cung cấp]. Nếu dữ liệu được lưu hoặc xử lý ngoài Việt Nam (ví dụ máy chủ tại Singapore, hoặc nhà cung cấp AI khi bật AI), chúng tôi thực hiện thủ tục chuyển dữ liệu cá nhân ra nước ngoài theo pháp luật Việt Nam.

**Biện pháp bảo mật:**

- Mọi kết nối đều mã hóa bằng HTTPS.
- Mã truy cập Trang và thông tin đăng nhập kênh được mã hóa khi lưu (AES-256-GCM), không bao giờ gửi về trình duyệt và không ghi vào nhật ký.
- Mật khẩu nhân viên chỉ được lưu dưới dạng mã băm.
- Chỉ nhân viên Dezon có tài khoản mới truy cập được. Quyền được chia theo vai trò (quản trị viên, nhân viên bán hàng), và thao tác quan trọng được ghi nhật ký.
- Nhật ký hệ thống thông thường không ghi nội dung tin nhắn.
- Dữ liệu được sao lưu [ĐIỀN: tần suất sao lưu].

Không biện pháp nào an toàn tuyệt đối. Nếu xảy ra sự cố lộ lọt dữ liệu, chúng tôi sẽ khắc phục và thông báo theo quy định của pháp luật.

## 7. Thời gian lưu trữ

- **Tin nhắn, tệp đính kèm và thông tin khách:** lưu trong thời gian cần thiết để chăm sóc khách hàng, tối đa [ĐIỀN: số] tháng kể từ lần trò chuyện cuối. Sau đó dữ liệu bị xóa hoặc ẩn danh, trừ khi pháp luật yêu cầu lưu lâu hơn.
- **Bản gốc sự kiện kỹ thuật (webhook):** lưu kèm tin nhắn để xử lý lỗi. Chúng tôi đang thiết lập việc tự động xóa phần này sau 90 ngày. Trong mọi trường hợp, phần này bị xóa cùng tin nhắn khi tin nhắn bị xóa.
- **Mã truy cập Trang:** lưu (đã mã hóa) đến khi Trang bị ngắt kết nối khỏi Dezon Inbox, khi đó mã bị xóa.
- **Tài khoản nhân viên:** lưu trong thời gian làm việc, khóa khi nhân viên nghỉ việc và xóa sau [ĐIỀN: số] tháng.
- **Bản sao lưu:** tự động ghi đè sau [ĐIỀN: số] ngày.
- **Khi bạn yêu cầu xóa:** xem mục 9 và trang [Hướng dẫn xóa dữ liệu](https://dezon.vn/xoa-du-lieu).

## 8. Chia sẻ dữ liệu

Chúng tôi chỉ chia sẻ dữ liệu trong các trường hợp sau:

- **Meta Platforms:** tin nhắn đi qua Messenger, nên Meta cũng xử lý chúng theo [Chính sách quyền riêng tư của Meta](https://www.facebook.com/privacy/policy).
- **Nhà cung cấp dịch vụ làm thay cho Dezon:** họ xử lý dữ liệu theo hợp đồng và chỉ theo chỉ dẫn của Dezon.
  - Máy chủ: [ĐIỀN: tên nhà cung cấp, quốc gia]
  - Lưu trữ tệp: [ĐIỀN: tên nhà cung cấp, quốc gia]
  - Theo dõi lỗi: [ĐIỀN: tên dịch vụ, xóa dòng này nếu không dùng]
  - Công cụ thông báo nội bộ cho nhân viên: [ĐIỀN: ví dụ Lark, xóa dòng này nếu không dùng]
  - Nhà cung cấp AI: chỉ khi bật AI (xem mục 4).
- **Cơ quan nhà nước có thẩm quyền:** khi pháp luật yêu cầu.

Chúng tôi không chuyển dữ liệu nhận từ Meta cho bên môi giới dữ liệu hay mạng quảng cáo.

## 9. Quyền của bạn và cách thực hiện

Theo pháp luật Việt Nam, bạn có quyền:

- được biết về việc xử lý dữ liệu của mình;
- đồng ý hoặc rút lại sự đồng ý;
- xem và nhận bản sao dữ liệu của mình;
- yêu cầu chỉnh sửa dữ liệu;
- yêu cầu xóa dữ liệu;
- yêu cầu hạn chế xử lý, hoặc phản đối việc xử lý;
- khiếu nại, tố cáo, khởi kiện và yêu cầu bồi thường theo quy định của pháp luật.

**Cách gửi yêu cầu:**

- Gửi email tới [support@dezon.vn](mailto:support@dezon.vn), tiêu đề "Yêu cầu về dữ liệu cá nhân"; hoặc
- nhắn tin trực tiếp cho chính Trang Facebook của Dezon mà bạn đã nhắn.

Vui lòng cho biết: tên Facebook của bạn, Trang bạn đã nhắn, khoảng thời gian trò chuyện, và việc bạn muốn chúng tôi làm. Để bảo vệ bạn, chúng tôi có thể cần xác minh bạn là chủ tài khoản, ví dụ nhờ bạn nhắn một mã ngắn từ chính tài khoản Messenger đó.

Chúng tôi phản hồi trong vòng 72 giờ. Nếu không thể đáp ứng một phần yêu cầu, chúng tôi sẽ nêu rõ lý do.

**Xóa dữ liệu:** xem hướng dẫn chi tiết tại [https://dezon.vn/xoa-du-lieu](https://dezon.vn/xoa-du-lieu).

## 10. Trẻ em

Dezon Inbox và các Trang của Dezon không hướng tới trẻ em dưới 16 tuổi. Nếu bạn là cha mẹ hoặc người giám hộ và biết con mình đã gửi dữ liệu cho Dezon, hãy liên hệ để chúng tôi xóa.

## 11. Thay đổi chính sách

Khi thay đổi chính sách này, chúng tôi sẽ cập nhật ngày ở đầu trang. Với thay đổi quan trọng, như bật AI tự trả lời, chúng tôi cập nhật chính sách trước khi áp dụng.

## 12. Liên hệ

[ĐIỀN: tên pháp lý công ty]. Địa chỉ: [ĐIỀN: địa chỉ trụ sở]. Email: [support@dezon.vn](mailto:support@dezon.vn). Điện thoại: [ĐIỀN: số điện thoại].

<!-- LANG:en -->

# Dezon Inbox Privacy Policy

Last updated: 5 November 2026

## 1. Who we are

Dezon Inbox is the internal inbox software of [ĐIỀN: company legal name] ("Dezon", "we"). Dezon staff use it to receive and reply, in one place, to messages that customers send through Messenger to Dezon's Facebook Pages.

- Legal name: [ĐIỀN: company legal name]
- Enterprise code: [ĐIỀN: enterprise/tax code]
- Registered address: [ĐIỀN: registered address]
- Website: [https://dezon.vn](https://dezon.vn)
- Privacy email: [support@dezon.vn](mailto:support@dezon.vn)
- Phone: [ĐIỀN: phone number]

Dezon decides the purposes and means of processing the personal data described in this policy (the personal data controller and processor under Vietnamese law).

Dezon Inbox is used only by Dezon staff. It is not a public service. This policy covers:

- **customers** and anyone else who messages a Dezon Facebook Page;
- **Dezon staff** who use Dezon Inbox, including when they log in with Facebook to connect a Page.

Dezon Inbox may also collect messages from Dezon's other channels (for example Zalo). This policy describes data received from Facebook and Messenger in detail. Data from other channels is protected under the same principles.

## 2. Data we process

### 2.1 When you message a Dezon Facebook Page

- **Profile information provided by Meta:** your Facebook display name and profile picture. We keep a copy of the profile picture in our file storage.
- **Page-scoped ID (PSID):** a number Meta assigns to you for each Page. It is not your Facebook account ID.
- **Conversation content:** messages you send and Dezon's replies, timestamps, and delivered/read status.
- **Attachments:** photos, videos, audio, files, stickers, and location if you share it.
- **Information you choose to give in the chat:** for example phone number, email, address, design needs, budget.
- **Context sent by Meta:** for example whether you started the chat from an ad, an m.me link or a Page button, and which buttons you tapped.
- **Earlier conversation history** in the Page inbox. When a Page is connected, we may sync this history so staff have context.
- **Information added by staff:** notes, tags, assigned staff member, conversation status.
- **Technical data:** the original event payloads Meta sends to our system (webhooks), used for troubleshooting.

We do not ask for sensitive personal data. Please do not send ID numbers, card or bank details, or health information through Messenger. If you have sent any, we use it only for the purpose you requested, and you can ask us to delete it.

### 2.2 Facebook Page information

The Page name, Page ID and Page access token. Meta issues these when a Dezon Page admin connects the Page to Dezon Inbox.

### 2.3 Dezon staff

- Name, work email and role. Passwords are stored only as hashes, never in plain text.
- When you connect a Page with Facebook Login for Business, we receive your app-scoped user ID and Facebook name, the list of Pages you manage (with your role on each Page), and access tokens. Your user access token is used only during the connection step and is not stored. We keep only the ID and Facebook name of the person who connected each Page, and the access tokens of the Pages selected.
- Logs: which staff member sent which message, changes to channels and customer details, and technical access logs (time, IP address, requested path). They are used for security and auditing.

## 3. How we use data

- To receive, display and reply to your messages: consultations, quotes, customer care, design orders.
- To keep conversation history, so any staff member who picks up your chat has the context and does not ask you again.
- For internal collaboration: assigning staff, notes, notifying staff of new messages.
- To secure the system, find errors, prevent abuse, and manage staff access.
- To meet our legal obligations.

We **do not sell or rent** your data. We do not use it for advertising or to build profiles for third parties, and we do not send bulk promotional messages through Messenger.

## 4. Artificial intelligence (AI)

**As of 5 November 2026, Dezon Inbox does not use AI.** Every reply is written and sent by a Dezon staff member.

**Planned:** Dezon plans to add an AI assistant that:

- drafts suggested replies for staff to review before sending;
- for some Pages or channels chosen by Dezon, answers common questions automatically (designs, prices, availability), including outside working hours.

When AI is enabled:

- The relevant message content (text and images) and a summary of the customer's needs will be sent to an AI provider to generate replies. Provider: [ĐIỀN: AI provider name, planned: Anthropic (Claude API)]. The provider's servers may be located outside Vietnam.
- We send only the data needed, never access tokens or passwords.
- We only use providers that commit in a contract to process the data solely on Dezon's instructions and not to use it to train their models.
- The AI may keep a summary of your needs (designs of interest, budget, style) so you are not asked again.
- The AI hands the conversation to a staff member when a human is needed (for example discount requests or complaints) or when you ask for one. **You can ask to talk to a person at any time.**
- Automated replies will be labelled as automated where the law requires it, and as Meta recommends.
- The AI does not make decisions with legal or similarly significant effects on you. Final prices, discounts and contracts are always decided by staff.

We will update this policy, and its date, **before** AI is enabled.

## 5. Legal basis

We process personal data under Vietnamese personal data protection law, including Decree 13/2023/ND-CP and [ĐIỀN: other laws in force, to be confirmed by a lawyer].

- **Your consent:** when you message a Dezon Page and share information, you consent to Dezon processing it to reply to and advise you, as described in this policy. For other purposes, such as automated AI replies or promotional messages, we will ask for separate consent where the law requires it. You can withdraw consent at any time. Withdrawal does not affect processing that took place before it.
- **Performance of a contract:** when you order a service, we process data to perform the contract and our obligations to you.
- **Legal obligations:** when a competent authority requires it under the law.
- **Staff:** under employment contracts and Dezon's internal rules.

## 6. Storage location and security

**Location:** data is stored in a database and file storage on servers rented by Dezon in [ĐIỀN: Vietnam or Singapore, provider name]. If data is stored or processed outside Vietnam (for example servers in Singapore, or an AI provider once AI is enabled), we complete the procedures for transferring personal data abroad required by Vietnamese law.

**Security measures:**

- All connections are encrypted with HTTPS.
- Page access tokens and channel credentials are encrypted at rest (AES-256-GCM), never sent to the browser, and never written to logs.
- Staff passwords are stored only as hashes.
- Only Dezon staff with an account can access the system. Access is role-based (admin, sales agent), and important actions are logged.
- Normal system logs do not record message content.
- Data is backed up [ĐIỀN: backup frequency].

No measure is perfectly secure. If a data breach occurs, we will remedy it and give notice as required by law.

## 7. Retention

- **Messages, attachments and customer information:** kept as long as needed for the customer relationship, at most [ĐIỀN: number] months after the last conversation. After that they are deleted or anonymised, unless the law requires longer retention.
- **Original technical event payloads (webhooks):** stored with each message for troubleshooting. We are setting up automatic deletion of these payloads after 90 days. In any case, they are deleted together with the message they belong to.
- **Page access tokens:** kept (encrypted) until the Page is disconnected from Dezon Inbox, then deleted.
- **Staff accounts:** kept during employment, disabled when the person leaves, and deleted after [ĐIỀN: number] months.
- **Backups:** overwritten automatically after [ĐIỀN: number] days.
- **When you ask for deletion:** see section 9 and the [Data Deletion Instructions](https://dezon.vn/xoa-du-lieu) page.

## 8. Sharing

We share data only in these cases:

- **Meta Platforms:** messages travel through Messenger, so Meta also processes them under the [Meta Privacy Policy](https://www.facebook.com/privacy/policy).
- **Service providers working for Dezon:** they process data under contract and only on Dezon's instructions.
  - Hosting: [ĐIỀN: provider name, country]
  - File storage: [ĐIỀN: provider name, country]
  - Error monitoring: [ĐIỀN: service name, remove this line if not used]
  - Internal staff notifications: [ĐIỀN: e.g. Lark, remove this line if not used]
  - AI provider: only once AI is enabled (see section 4).
- **Competent authorities:** when required by law.

We do not transfer data received from Meta to data brokers or advertising networks.

## 9. Your rights and how to use them

Under Vietnamese law, you have the right to:

- be informed about the processing of your data;
- give or withdraw consent;
- access your data and receive a copy;
- ask for your data to be corrected;
- ask for your data to be deleted;
- ask us to restrict processing, or object to processing;
- complain, report, sue and claim compensation as provided by law.

**How to make a request:**

- Email [support@dezon.vn](mailto:support@dezon.vn) with the subject "Personal data request"; or
- message the same Dezon Facebook Page you messaged before.

Please tell us your Facebook name, the Page you messaged, roughly when, and what you want us to do. To protect you, we may need to confirm that you own the account, for example by asking you to send a short code from that same Messenger account.

We respond within 72 hours. If we cannot meet part of a request, we will explain why.

**Data deletion:** see the detailed instructions at [https://dezon.vn/xoa-du-lieu](https://dezon.vn/xoa-du-lieu).

## 10. Children

Dezon Inbox and Dezon's Pages are not directed at children under 16. If you are a parent or guardian and know that your child has sent data to Dezon, contact us and we will delete it.

## 11. Changes

When we change this policy, we update the date at the top. For important changes, such as enabling automated AI replies, we update the policy before the change takes effect.

## 12. Contact

[ĐIỀN: company legal name]. Address: [ĐIỀN: registered address]. Email: [support@dezon.vn](mailto:support@dezon.vn). Phone: [ĐIỀN: phone number].
