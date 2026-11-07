# EduTrack – Quản lý điểm THCS (Chuẩn Thông tư 22/2021/TT-BGDĐT)

Website chạy trên Netlify: giao diện trong `public/`, máy chủ serverless trong `netlify/functions/api/`, cơ sở dữ liệu PostgreSQL qua Netlify Database (Drizzle ORM).

---

## 🌟 Các tính năng chính
1. **Phân quyền đa cấp**:
   - **Quản trị hệ thống**: Quyền tối cao, tạo tài khoản và phân quyền cho giáo viên làm Quản trị viên hỗ trợ.
   - **Giáo viên có quyền quản trị**: Hỗ trợ thêm lớp, thêm học sinh, phân công giảng dạy, quản lý tài khoản phụ huynh.
   - **Giáo viên bộ môn**: Nhập điểm các lớp và môn được phân công.
   - **Giáo viên chủ nhiệm**: Xem toàn bộ điểm các môn và danh sách liên lạc (SĐT bố mẹ) của lớp mình phụ trách.
   - **Phụ huynh**: Tra cứu kết quả học tập (điểm số, nhận xét từng học kỳ và cả năm).
2. **Sổ điểm chuẩn Thông tư 22/2021/TT-BGDĐT**:
   - **8 môn tính điểm số (0 – 10)**: Ngữ văn, Toán, Tiếng Anh, GDCD, Lịch sử & Địa lí, KHTN, Công nghệ, Tin học. Tự động tính ĐTB học kỳ và cả năm.
   - **4 môn đánh giá nhận xét (Đạt / Chưa đạt)**: Giáo dục thể chất, Nghệ thuật, HĐTN-HN, GD địa phương.
     - Giáo viên có thể nhập: `Đ` (hoặc `1`, `D`, `Đạt`) hoặc `CĐ` (hoặc `0`, `CD`, `Chưa đạt`).
     - Tự động hiển thị huy hiệu `Đạt` / `Chưa đạt`, tính kết quả học kỳ và cả năm đúng chuẩn Bộ GD&ĐT.
   - Hỗ trợ dán (paste) trực tiếp cả cột hoặc bảng điểm từ Excel vào web.
3. **Nhập học sinh từ Excel thông minh**:
   - Tự động nhận diện nhiều dạng tên cột tiếng Việt (có dấu/không dấu).
   - Tự sinh mã học sinh duy nhất (không lo trùng lặp hay ghi đè).
   - Tự động tạo tài khoản phụ huynh theo SĐT với mật khẩu dễ nhớ (`tên con + ngày sinh`).

---

## 🚀 Hướng dẫn đưa lên GitHub và triển khai trên Netlify

### Cách 1: Đưa lên GitHub bằng tay (Upload files)
1. Giải nén file ZIP `edutrack-hoan-thien.zip`.
2. Trên GitHub, mở repository của bạn (hoặc tạo repository mới `edutrack`), chọn **Add file** → **Upload files**.
3. Kéo thả **toàn bộ nội dung bên trong** thư mục vừa giải nén (bao gồm các thư mục `public`, `netlify`, `db` và các file `package.json`, `package-lock.json`, `netlify.toml`, `drizzle.config.ts`, `.gitignore`, `README_HUONG_DAN.md`).
4. Chọn **"Commit directly to the main branch"** và bấm **Commit changes**.

### Cách 2: Kết nối với Netlify
1. Đăng nhập [Netlify](https://app.netlify.com/).
2. Chọn **Add new site** → **Import an existing project** → Chọn **GitHub** và chọn repo `edutrack`.
3. Netlify tự động nhận diện cấu hình trong `netlify.toml`:
   - **Build command**: `npm run build` (tự động chạy lệnh migrate tạo bảng cơ sở dữ liệu).
   - **Publish directory**: `public`.
4. Bật **Netlify Database** cho dự án (trong tab Database/Integrations) để cấp kết nối PostgreSQL serverless.
5. Sau khi triển khai xong, mở trang web: Màn hình **Khởi tạo hệ thống** sẽ xuất hiện lần đầu tiên để bạn tạo tài khoản **Quản trị hệ thống**.

---

## 💡 Hướng dẫn phân quyền cho Giáo viên làm Quản trị viên
1. Đăng nhập bằng tài khoản **Quản trị hệ thống**.
2. Vào mục **Giáo viên & phân công**.
3. Tại danh sách giáo viên, bấm nút **Sửa** (hoặc bấm **+ Thêm giáo viên** khi tạo mới).
4. Tích chọn vào ô: `☑ Cấp quyền quản trị viên (hỗ trợ thêm lớp, học sinh, phân công...)`.
5. Bấm **Lưu**. Giáo viên đó đăng nhập sẽ có đầy đủ các menu quản lý lớp, học sinh, phân công và phụ huynh.
