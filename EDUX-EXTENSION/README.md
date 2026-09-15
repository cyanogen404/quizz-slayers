# ⚔️ EDUX Slayers Browser Extension (Plugin Trình Duyệt)

Bộ công cụ tự động hóa giải Slide bài giảng & Bài kiểm tra trên nền tảng EDUX dưới dạng **Chrome/Edge Extension (Manifest V3)**.

---

## 🚀 Tính năng nổi bật

1. **⚡ Slide Brute-force Solver**:
   - Thử sai thông minh & ghi nhớ các đáp án đã thử để tìm đáp án đúng nhanh nhất.
   - Tự động nhận diện các nút: `Trả lời trên lớp`, `Kiểm tra`, `Thử lại`, `Câu tiếp theo`, `Trang sau`.
   - Tự động chuyển trang khi hoàn thành slide hoặc slide không có câu hỏi.

2. **📝 Test Solver (Giải Bài Kiểm Tra)**:
   - Nhập danh sách đáp án dạng văn bản (`1. A`, `2. C`, `3. B`) hoặc dạng JSON để extension tự động click điền bài kiểm tra.
   - Trích xuất toàn bộ danh sách câu hỏi & đáp án trên trang đề thi vào Clipboard chỉ với 1 click.

3. **📊 Bảng Điểm & Cảnh Báo Bài Tập AI**:
   - Tự động lấy điểm số cao nhất của các bài tập (`[Bài tập AI]`) và hiển thị huy hiệu trực tiếp (`🏆 Điểm: X/10`).
   - Cảnh báo trực quan (`⚠️ Chưa làm`) cho các bài tập chưa nộp để tránh bỏ sót.
   - Banner tổng quan tiến độ môn học hiển thị ngay đầu danh sách bài học kèm nút cuộn nhanh tới bài chưa làm.
   - Tab **📊 Điểm số** trong Popup tiện ích giúp theo dõi toàn diện tiến độ của môn học hiện tại.

---

## 🛠 Hướng dẫn Cài đặt vào Trình duyệt (Chrome / Edge / Brave / Opera)

1. Mở trình duyệt web của bạn.
2. Truy cập trang quản lý extension:
   - **Google Chrome**: Gõ `chrome://extensions/` lên thanh địa chỉ.
   - **Microsoft Edge**: Gõ `edge://extensions/` lên thanh địa chỉ.
   - **Brave**: Gõ `brave://extensions/` lên thanh địa chỉ.
3. Bật chế độ nhà phát triển (**Developer mode**) ở góc trên bên phải màn hình.
4. Nhấn nút **Tải tiện ích đã giải nén** (*Load unpacked*).
5. Trỏ tới thư mục: `D:\CODE\quizz-slayers\EDUX-EXTENSION` và nhấn **Select Folder**.

---

## 📖 Hướng dẫn Sử dụng

### 1. Giải Slide bài giảng tự động:
- Đăng nhập vào trang web EDUX trên trình duyệt của bạn như bình thường.
- Mở slide bài giảng đang học.
- Click icon **EDUX Slayers** ⚔️ ở góc trình duyệt.
- Nhấn **▶️ Bắt đầu giải Slide**.

### 2. Giải bài kiểm tra (Test Solver):
- Mở trang bài kiểm tra EDUX.
- Mở Extension ➔ Chuyển sang Tab **📝 Đề thi**.
- Nhấn **📋 Trích xuất câu hỏi** để copy câu hỏi vào bộ nhớ tạm (dán vào AI như ChatGPT/Claude để giải).
- Nhập/dán danh sách đáp án vào ô văn bản (VD: `1. A`, `2. B`, `3. C` hoặc JSON).
- Nhấn **✨ Tự động điền đáp án**.

### 3. Theo dõi điểm số bài tập:
- Mở trang môn học EDUX (`/subject?id=...`).
- Xem điểm số cao nhất và cảnh báo chưa làm ngay bên cạnh các nút `[Bài tập AI]`.
- Hoặc mở Popup extension ➔ Chuyển sang Tab **📊 Điểm số** để xem thống kê chi tiết.

---

*Lưu ý: Công cụ này được tạo ra cho mục đích nghiên cứu và học tập. Vui lòng sử dụng có trách nhiệm.*
