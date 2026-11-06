# EduTrack – Quản lý điểm THCS

Website chạy trên Netlify: giao diện trong `public/`, máy chủ trong `netlify/functions/`, cơ sở dữ liệu là Netlify Database (bảng định nghĩa trong `db/schema.ts`, file tạo bảng trong `netlify/database/migrations/`). Không còn dùng Supabase.

## Đưa lên GitHub bằng tay (Upload files)
1. Giải nén file ZIP.
2. Trên GitHub, mở repo `edutrack`, chọn Add file → Upload files, rồi kéo thả **toàn bộ nội dung bên trong** thư mục đã giải nén (gồm cả các thư mục `public`, `netlify`, `db` và các file `package.json`, `package-lock.json`, `netlify.toml`, `drizzle.config.ts`, `.gitignore`).
3. Chọn "Commit directly to the main branch" và bấm Commit changes.
4. Tuỳ chọn: xoá các file cũ không còn dùng là `index.html`, `assets/` và `supabase/` ở thư mục gốc.

Netlify tự dựng lại trang và tạo bảng dữ liệu. Lần đầu mở trang, hãy tạo tài khoản quản trị ở màn hình "Khởi tạo hệ thống".
