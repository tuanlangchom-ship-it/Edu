// EduTrack – giao diện web (không cần build). Dữ liệu lấy qua /api/* (Netlify Functions + Netlify Database).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");
const ROLE_LABEL = { admin: "Quản trị viên", teacher: "Giáo viên", parent: "Phụ huynh" };
let me = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: method !== "GET" ? { "Content-Type": "application/json" } : {},
    body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login" && path !== "/api/change-password") { me = null; render(); }
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = ""), 3200);
}

// Chạy một thao tác, hiện lỗi bằng thông báo nếu thất bại.
async function attempt(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

function currentSchoolYear() {
  const d = new Date(), y = d.getFullYear();
  return d.getMonth() >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

let XLSXlib = null;
async function loadXLSX() {
  if (!XLSXlib) XLSXlib = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  return XLSXlib;
}
async function downloadXlsx(filename, rows, sheetName = "Sheet1") {
  const XLSX = await loadXLSX();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = rows[0].map((_, i) => ({ wch: Math.min(40, Math.max(10, ...rows.map((r) => String(r[i] ?? "").length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

// ---------- Modal ----------
const modal = $("#modal");
function openModal(html, onSubmit) {
  const body = $("#modal-body");
  body.innerHTML = html;
  body.onsubmit = async (e) => {
    const submitter = e.submitter;
    if (!submitter || submitter.value === "cancel") return;
    e.preventDefault();
    if (onSubmit) {
      const ok = await attempt(() => onSubmit(new FormData(body), body), submitter);
      if (ok !== false && ok !== undefined) modal.close();
    } else modal.close();
  };
  modal.showModal();
  $("input,select", body)?.focus();
}
function showSecret(title, rows, note = "Mật khẩu chỉ hiển thị một lần. Hãy ghi lại hoặc gửi cho người dùng ngay.") {
  openModal(`<h2>${esc(title)}</h2>
    ${rows.map(([k, v]) => `<div class="field"><span>${esc(k)}</span><div class="secret">${esc(v)}</div></div>`).join("")}
    <div class="notice warn">${esc(note)}</div>
    <div class="actions"><button class="btn" value="ok">Đã ghi lại</button></div>`);
}
function confirmBox(message, label = "Xoá") {
  return new Promise((resolve) => {
    openModal(`<h2>Xác nhận</h2><p>${esc(message)}</p>
      <div class="actions"><button class="btn ghost" value="cancel">Huỷ</button><button class="btn danger" value="ok">${esc(label)}</button></div>`,
      async () => { resolve(true); return true; });
    modal.addEventListener("close", () => resolve(false), { once: true });
  });
}

// ---------- Khởi động ----------
async function boot() {
  try {
    const { user } = await api("GET", "/api/me");
    me = user;
    if (!me) {
      const { needsSetup } = await api("GET", "/api/setup-status");
      if (needsSetup) return renderSetup();
    }
  } catch (e) {
    app.innerHTML = `<div class="login"><div class="card"><div class="notice err">Không kết nối được máy chủ: ${esc(e.message)}</div></div></div>`;
    return;
  }
  render();
}
window.addEventListener("hashchange", () => me && renderPage());

function render() {
  if (!me) return renderLogin();
  renderShell();
  renderPage();
}

function loginFrame(inner) {
  app.innerHTML = `<div class="login"><div class="card">
    <div class="row" style="align-items:center"><div class="logo">E</div><div class="brand"><b>EduTrack</b><small>Quản lý học sinh và kết quả học tập</small></div></div>
    ${inner}</div></div>`;
}

function renderSetup() {
  loginFrame(`<h1>Khởi tạo hệ thống</h1>
    <p>Tạo tài khoản <b>quản trị viên</b> đầu tiên. Trang này chỉ xuất hiện một lần, khi hệ thống chưa có quản trị viên.</p>
    <form id="f">
      <label class="field"><span>Họ và tên</span><input type="text" name="fullName" required></label>
      <label class="field"><span>Tên đăng nhập (chữ không dấu, số)</span><input type="text" name="username" required autocomplete="username" pattern="[A-Za-z0-9._\\-]{3,50}"></label>
      <label class="field"><span>Mật khẩu (ít nhất 6 ký tự)</span><input type="password" name="password" required minlength="6" autocomplete="new-password"></label>
      <button class="btn">Tạo tài khoản quản trị</button>
    </form>`);
  $("#f").onsubmit = (e) => {
    e.preventDefault();
    attempt(async () => {
      await api("POST", "/api/setup", Object.fromEntries(new FormData(e.target)));
      await boot();
    }, e.submitter);
  };
}

function renderLogin() {
  loginFrame(`<h1>Đăng nhập</h1>
    <p>Phụ huynh: đăng nhập bằng <b>số điện thoại</b> đã đăng ký với nhà trường và mật khẩu được cấp.<br>Giáo viên: dùng tài khoản do quản trị viên cấp.</p>
    <form id="f">
      <label class="field"><span>Số điện thoại / Tên đăng nhập</span><input type="text" name="username" required autocomplete="username" inputmode="text"></label>
      <label class="field"><span>Mật khẩu</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn">Đăng nhập</button>
      <small class="muted">Quên mật khẩu? Liên hệ giáo viên chủ nhiệm hoặc nhà trường để được cấp lại.</small>
    </form>`);
  $("#f").onsubmit = (e) => {
    e.preventDefault();
    attempt(async () => {
      await api("POST", "/api/login", Object.fromEntries(new FormData(e.target)));
      await boot();
    }, e.submitter);
  };
}

// ---------- Khung ứng dụng ----------
const NAV = {
  admin: [
    ["classes", "Quản lý lớp"], ["students", "Hồ sơ học sinh"], ["grades", "Sổ điểm"],
    ["teachers", "Giáo viên & phân công"], ["parents", "Tài khoản phụ huynh"], ["subjects", "Môn học"],
  ],
  teacher: [["grades", "Sổ điểm"]],
  parent: [["results", "Kết quả học tập"]],
};
// Giáo viên chủ nhiệm có thêm mục "Học sinh lớp chủ nhiệm".
const nav = () => (me.role === "teacher" && me.isHomeroom ? [["grades", "Sổ điểm"], ["students", "Học sinh lớp chủ nhiệm"]] : NAV[me.role]);
const currentRoute = () => {
  const r = (location.hash.replace(/^#\/?/, "").split("?")[0]) || nav()[0][0];
  return nav().some(([k]) => k === r) ? r : nav()[0][0];
};
const hashParams = () => new URLSearchParams(location.hash.split("?")[1] || "");

function renderShell() {
  app.innerHTML = `
    <header class="topbar">
      <button class="btn ghost small menu-toggle" id="menu">☰</button>
      <div class="logo">E</div><div class="brand"><b>EduTrack</b><small>Quản lý điểm THCS</small></div>
      <div class="spacer"></div>
      <div class="who"><b>${esc(me.fullName || me.username)}</b><small>${ROLE_LABEL[me.role]} · ${esc(me.username)}</small></div>
      <button class="btn ghost small" id="pw">Đổi mật khẩu</button>
      <button class="btn ghost small" id="out">Đăng xuất</button>
    </header>
    <div class="shell">
      <nav class="side" id="side">${nav().map(([k, label], i) =>
        `<a href="#/${k}" data-k="${k}"><span class="num">${String(i + 1).padStart(2, "0")}</span>${esc(label)}</a>`).join("")}</nav>
      <main class="content" id="page"></main>
    </div>`;
  $("#menu").onclick = () => $("#side").classList.toggle("open");
  $("#side").onclick = () => $("#side").classList.remove("open");
  $("#out").onclick = () => attempt(async () => { await api("POST", "/api/logout", {}); me = null; location.hash = ""; render(); });
  $("#pw").onclick = changePasswordModal;
}

function changePasswordModal() {
  openModal(`<h2>Đổi mật khẩu</h2>
    <label class="field"><span>Mật khẩu hiện tại</span><input type="password" name="oldPassword" required autocomplete="current-password"></label>
    <label class="field"><span>Mật khẩu mới (ít nhất 6 ký tự)</span><input type="password" name="newPassword" required minlength="6" autocomplete="new-password"></label>
    <label class="field"><span>Nhập lại mật khẩu mới</span><input type="password" name="confirm" required minlength="6" autocomplete="new-password"></label>
    <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Huỷ</button><button class="btn" value="ok">Lưu</button></div>`,
    async (fd) => {
      if (fd.get("newPassword") !== fd.get("confirm")) throw new Error("Hai lần nhập mật khẩu mới không khớp.");
      await api("POST", "/api/change-password", { oldPassword: fd.get("oldPassword"), newPassword: fd.get("newPassword") });
      me.mustChangePassword = false;
      toast("Đã đổi mật khẩu.");
      renderPage();
      return true;
    });
}

function renderPage() {
  const r = currentRoute();
  $$("#side a").forEach((a) => a.classList.toggle("active", a.dataset.k === r));
  const page = $("#page");
  page.onclick = null;
  window.onbeforeunload = null;
  page.innerHTML = `<div class="empty">Đang tải…</div>`;
  const banner = me.mustChangePassword
    ? `<div class="notice warn">Bạn đang dùng mật khẩu do hệ thống cấp. Nên <button class="btn link" id="pw2">đổi mật khẩu</button> để bảo mật tài khoản.</div>` : "";
  const views = { classes: viewClasses, students: viewStudents, grades: viewGrades, teachers: viewTeachers, parents: viewParents, subjects: viewSubjects, results: viewResults };
  views[r](page).then(() => {
    if (banner) { page.insertAdjacentHTML("afterbegin", banner); $("#pw2").onclick = changePasswordModal; }
  }).catch((e) => { page.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; });
}

const head = (title, sub, right = "") =>
  `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="actions">${right}</div></div>`;

// ---------- Quản lý lớp ----------
async function viewClasses(page) {
  const [list, teachers] = await Promise.all([api("GET", "/api/classes"), api("GET", "/api/teachers")]);
  const teacherOpts = (sel) => `<option value="">— Chưa phân —</option>` +
    teachers.filter((t) => t.isActive).map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.fullName)}${t.role === "admin" ? " (Quản trị viên)" : ""}</option>`).join("");
  const years = [...new Set(list.map((c) => c.schoolYear))];
  page.innerHTML = head("Quản lý lớp", "Danh sách lớp theo năm học và giáo viên chủ nhiệm.", `<button class="btn" id="add">+ Thêm lớp</button>`) +
    (list.length ? years.map((y) => `<div class="card"><h2>Năm học ${esc(y)}</h2><div class="table-wrap"><table>
      <thead><tr><th>Lớp</th><th>Giáo viên chủ nhiệm</th><th class="num">Sĩ số</th><th></th></tr></thead><tbody>
      ${list.filter((c) => c.schoolYear === y).map((c) => `<tr>
        <td><b>${esc(c.name)}</b></td><td>${c.homeroomTeacherName ? esc(c.homeroomTeacherName) : `<span class="muted">Chưa phân</span>`}</td>
        <td class="num">${c.studentCount}</td>
        <td><div class="actions"><a class="btn ghost small" href="#/students?classId=${c.id}">Học sinh</a><a class="btn ghost small" href="#/grades?classId=${c.id}">Sổ điểm</a>
        <button class="btn ghost small" data-edit="${c.id}">Sửa</button><button class="btn danger small" data-del="${c.id}">Xoá</button></div></td></tr>`).join("")}
      </tbody></table></div></div>`).join("")
      : `<div class="card empty">Chưa có lớp nào. Bạn có thể thêm lớp thủ công, hoặc nhập file Excel ở mục <a href="#/students">Hồ sơ học sinh</a> – các lớp sẽ được tạo tự động.</div>`);

  const form = (c = {}) => openModal(`<h2>${c.id ? "Sửa lớp" : "Thêm lớp"}</h2>
    <div class="grid2"><label class="field"><span>Tên lớp</span><input type="text" name="name" required value="${esc(c.name)}" placeholder="VD: 6A1"></label>
    <label class="field"><span>Năm học</span><input type="text" name="schoolYear" required pattern="\\d{4}-\\d{4}" value="${esc(c.schoolYear || currentSchoolYear())}"></label></div>
    <label class="field"><span>Giáo viên chủ nhiệm</span><select name="homeroomTeacherId">${teacherOpts(c.homeroomTeacherId)}</select></label>
    <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Huỷ</button><button class="btn" value="ok">Lưu</button></div>`,
    async (fd) => {
      const body = Object.fromEntries(fd);
      await api(c.id ? "PUT" : "POST", c.id ? `/api/classes/${c.id}` : "/api/classes", body);
      toast("Đã lưu lớp."); viewClasses(page); return true;
    });
  $("#add").onclick = () => form();
  page.onclick = async (e) => {
    const ed = e.target.closest("[data-edit]"), del = e.target.closest("[data-del]");
    if (ed) form(list.find((c) => c.id === +ed.dataset.edit));
    if (del) {
      const c = list.find((x) => x.id === +del.dataset.del);
      if (await confirmBox(`Xoá lớp ${c.name} (${c.schoolYear})? Học sinh trong lớp sẽ chuyển sang trạng thái "chưa xếp lớp", điểm vẫn được giữ.`))
        attempt(async () => { await api("DELETE", `/api/classes/${c.id}`); toast("Đã xoá lớp."); viewClasses(page); });
    }
  };
}

// ---------- Hồ sơ học sinh ----------
const STUDENT_FIELDS = [
  ["studentCode", "Mã HS"], ["fullName", "Họ và tên"], ["dateOfBirth", "Ngày sinh"], ["gender", "Giới tính"], ["className", "Lớp"],
  ["address", "Địa chỉ"], ["fatherName", "Họ tên bố"], ["fatherPhone", "SĐT bố"], ["motherName", "Họ tên mẹ"], ["motherPhone", "SĐT mẹ"], ["note", "Ghi chú"],
];
// Các tên cột được chấp nhận (đã bỏ dấu, viết thường, bỏ khoảng trắng).
const HEADER_ALIASES = {
  studentCode: ["mahs", "mahocsinh", "ma", "mahsinh", "madinhdanh", "madinhdanhhocsinh", "mshs", "masohocsinh"],
  fullName: ["hovaten", "hoten", "hotenhocsinh", "tenhocsinh", "hovatenhocsinh", "hocsinh"],
  dateOfBirth: ["ngaysinh", "ngaythangnamsinh", "ngaythangsinh"],
  gender: ["gioitinh", "gt", "nunam", "phai"],
  className: ["lop", "tenlop", "lophoc"],
  address: ["diachi", "noio", "choohientai", "diachithuongtru", "hokhauthuongtru", "thuongtru"],
  fatherName: ["hotenbo", "tenbo", "hovatenbo", "hotencha", "hovatencha", "tencha", "bo", "cha"],
  fatherPhone: ["sdtbo", "sodienthoaibo", "dienthoaibo", "sdtcha", "sodienthoaicha", "dienthoaicha", "dtbo", "dtcha"],
  motherName: ["hotenme", "tenme", "hovatenme", "me"],
  motherPhone: ["sdtme", "sodienthoaime", "dienthoaime", "dtme"],
  parentName: ["hotenphuhuynh", "phuhuynh", "tenphuhuynh", "hovatenphuhuynh"],
  parentPhone: ["sdtphuhuynh", "sodienthoaiphuhuynh", "dienthoaiphuhuynh", "sodienthoai", "sdt", "dienthoai", "dtphuhuynh"],
  note: ["ghichu"],
};
const normHeader = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]/g, "");
function cellText(v) {
  if (v instanceof Date) return `${String(v.getDate()).padStart(2, "0")}/${String(v.getMonth() + 1).padStart(2, "0")}/${v.getFullYear()}`;
  return v === null || v === undefined ? "" : String(v).trim();
}

async function parseStudentFile(file) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  // Tìm dòng tiêu đề trong 20 dòng đầu (file có thể có tên trường, tiêu đề phía trên).
  let headerIdx = -1, map = {};
  for (let i = 0; i < Math.min(20, aoa.length); i++) {
    const m = {};
    aoa[i].forEach((h, col) => {
      const n = normHeader(h);
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(n) && m[key] === undefined) m[key] = col;
    });
    if (m.fullName !== undefined) { headerIdx = i; map = m; break; }
  }
  if (headerIdx < 0) throw new Error('Không tìm thấy dòng tiêu đề. File cần có cột "Họ và tên" (xem file mẫu).');
  const rows = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i], o = { _row: i + 1 };
    for (const [key, col] of Object.entries(map)) o[key] = cellText(r[col]);
    if (!o.fullName) continue;
    if (!o.fatherPhone && o.parentPhone) { o.fatherPhone = o.parentPhone; o.fatherName ||= o.parentName; }
    else if (!o.motherPhone && o.parentPhone && o.parentPhone !== o.fatherPhone) { o.motherPhone = o.parentPhone; o.motherName ||= o.parentName; }
    delete o.parentPhone; delete o.parentName;
    rows.push(o);
  }
  const found = Object.keys(map).filter((k) => !k.startsWith("parent"));
  return { rows, found, sheet: wb.SheetNames[0] };
}

async function viewStudents(page) {
  const params = hashParams();
  const [classList, list] = await Promise.all([api("GET", "/api/classes"), api("GET", "/api/students" + (params.get("classId") ? `?classId=${params.get("classId")}` : ""))]);
  const sel = params.get("classId") || "";
  const isAdmin = me.role === "admin";
  page.innerHTML = (isAdmin ? head("Hồ sơ học sinh", "Nhập danh sách từ Excel – hệ thống tự tạo lớp và tài khoản phụ huynh theo số điện thoại.",
    `<button class="btn ghost" id="tpl">Tải file Excel mẫu</button><button class="btn ghost" id="add">+ Thêm học sinh</button><button class="btn" id="imp">Nhập từ Excel</button>`)
    : head("Học sinh lớp chủ nhiệm", "Xem, sửa hồ sơ học sinh và cấp lại mật khẩu cho phụ huynh lớp bạn chủ nhiệm.")) +
    `<div id="import-area"></div>
    <div class="card"><div class="row" style="margin-bottom:12px">
      <label class="field"><span>Lớp</span><select id="cls"><option value="">Tất cả lớp</option>
        ${classList.map((c) => `<option value="${c.id}" ${String(c.id) === sel ? "selected" : ""}>${esc(c.name)} · ${esc(c.schoolYear)}</option>`).join("")}
        ${isAdmin ? `<option value="none" ${sel === "none" ? "selected" : ""}>Chưa xếp lớp</option>` : ""}</select></label>
      <label class="field grow"><span>Tìm kiếm</span><input type="search" id="q" placeholder="Tên, mã HS hoặc SĐT…"></label>
      <button class="btn ghost" id="exp">Xuất Excel</button>
    </div><div id="tbl"></div></div>`;

  const selected = new Set();
  const drawTable = () => {
    const q = normHeader($("#q").value);
    const rows = list.filter((s) => !q || normHeader(`${s.fullName} ${s.studentCode} ${s.fatherPhone} ${s.motherPhone}`).includes(q));
    const allOn = rows.length > 0 && rows.every((s) => selected.has(s.id));
    $("#tbl").innerHTML = rows.length ? `<div class="row" style="margin:0 0 8px;justify-content:space-between;align-items:center">
      <span class="muted">${rows.length} học sinh · <b>${selected.size}</b> đã chọn</span>
      <div class="actions"><button class="btn ghost small" id="sel-clear" ${selected.size ? "" : "disabled"}>Bỏ chọn</button>
      <button class="btn small" id="sel-reset" ${selected.size ? "" : "disabled"}>Cấp lại mật khẩu phụ huynh của ${selected.size} học sinh đã chọn</button></div></div><div class="table-wrap"><table>
      <thead><tr><th><input type="checkbox" id="sel-all" ${allOn ? "checked" : ""} title="Chọn tất cả"></th><th>#</th><th>Mã HS</th><th>Họ và tên</th><th>Ngày sinh</th><th>GT</th><th>Lớp</th><th>Bố</th><th>Mẹ</th><th></th></tr></thead><tbody>
      ${rows.map((s, i) => `<tr><td><input type="checkbox" data-sel="${s.id}" ${selected.has(s.id) ? "checked" : ""}></td><td class="muted">${i + 1}</td><td class="nowrap">${esc(s.studentCode)}</td><td><b>${esc(s.fullName)}</b></td>
        <td class="nowrap">${esc(s.dateOfBirth)}</td><td>${esc(s.gender)}</td><td class="nowrap">${s.className ? esc(s.className) : `<span class="tag">Chưa xếp</span>`}</td>
        <td>${esc(s.fatherName)}${s.fatherPhone ? `<br><small class="muted">${esc(s.fatherPhone)}</small>` : ""}</td>
        <td>${esc(s.motherName)}${s.motherPhone ? `<br><small class="muted">${esc(s.motherPhone)}</small>` : ""}</td>
        <td><div class="actions"><button class="btn ghost small" data-edit="${s.id}">Sửa</button>${isAdmin ? `<button class="btn danger small" data-del="${s.id}">Xoá</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">Chưa có học sinh nào${q ? " khớp tìm kiếm" : ""}.</div>`;
    if (!rows.length) return;
    $("#sel-all").onchange = (e) => { rows.forEach((s) => (e.target.checked ? selected.add(s.id) : selected.delete(s.id))); drawTable(); };
    $$("[data-sel]").forEach((cb) => (cb.onchange = () => { cb.checked ? selected.add(+cb.dataset.sel) : selected.delete(+cb.dataset.sel); drawTable(); }));
    $("#sel-clear").onclick = () => { selected.clear(); drawTable(); };
    $("#sel-reset").onclick = () => bulkResetParents({ studentIds: [...selected] }, selected.size, `phụ huynh của ${selected.size} học sinh đã chọn`, () => { selected.clear(); drawTable(); });
  };
  drawTable();
  $("#q").oninput = drawTable;
  $("#cls").onchange = (e) => (location.hash = "#/students" + (e.target.value ? `?classId=${e.target.value}` : ""));
  if (isAdmin) $("#tpl").onclick = () => attempt(() => downloadXlsx("EduTrack_mau_nhap_hoc_sinh.xlsx", [
    STUDENT_FIELDS.map(([, l]) => l),
    ["HS001", "Nguyễn Văn An", "05/09/2013", "Nam", "6A1", "Thôn 1, xã A", "Nguyễn Văn Bình", "0912345678", "Trần Thị Cúc", "0987654321", ""],
    ["HS002", "Lê Thị Bích", "12/03/2013", "Nữ", "6A1", "Thôn 2, xã A", "Lê Văn Dũng", "0903123456", "", "", "Anh chị em ruột dùng chung SĐT được"],
  ], "HocSinh"));
  $("#exp").onclick = () => attempt(() => downloadXlsx("EduTrack_danh_sach_hoc_sinh.xlsx", [
    STUDENT_FIELDS.map(([, l]) => l), ...list.map((s) => STUDENT_FIELDS.map(([k]) => s[k] ?? "")),
  ], "HocSinh"));
  if (isAdmin) $("#imp").onclick = () => renderImport($("#import-area"), () => viewStudents(page));
  if (isAdmin) $("#add").onclick = () => studentForm({ classId: sel && sel !== "none" ? +sel : null }, classList, () => viewStudents(page));
  page.onclick = async (e) => {
    const ed = e.target.closest("[data-edit]"), del = e.target.closest("[data-del]");
    if (ed) studentForm(list.find((s) => s.id === +ed.dataset.edit), classList, () => viewStudents(page));
    if (del) {
      const s = list.find((x) => x.id === +del.dataset.del);
      if (await confirmBox(`Xoá học sinh ${s.fullName}? Toàn bộ điểm của học sinh này cũng bị xoá.`))
        attempt(async () => { await api("DELETE", `/api/students/${s.id}`); toast("Đã xoá học sinh."); viewStudents(page); });
    }
  };
}

function studentForm(s, classList, done) {
  const inp = (k, label, extra = "") => `<label class="field"><span>${label}</span><input type="text" name="${k}" value="${esc(s[k])}" ${extra}></label>`;
  openModal(`<h2>${s.id ? "Sửa hồ sơ học sinh" : "Thêm học sinh"}</h2>
    <div class="grid2">${inp("studentCode", "Mã HS", 'placeholder="Để trống để tự sinh"')}${inp("fullName", "Họ và tên", "required")}
    ${inp("dateOfBirth", "Ngày sinh", 'placeholder="dd/mm/yyyy"')}
    <label class="field"><span>Giới tính</span><select name="gender"><option value=""></option>${["Nam", "Nữ"].map((g) => `<option ${s.gender === g ? "selected" : ""}>${g}</option>`).join("")}</select></label></div>
    <label class="field"><span>Lớp${me.role === "admin" ? "" : " (chỉ quản trị viên được chuyển lớp)"}</span><select name="classId" ${me.role === "admin" ? "" : "disabled"}><option value="">— Chưa xếp lớp —</option>
      ${classList.map((c) => `<option value="${c.id}" ${c.id === s.classId ? "selected" : ""}>${esc(c.name)} · ${esc(c.schoolYear)}</option>`).join("")}</select></label>
    ${inp("address", "Địa chỉ")}
    <div class="grid2">${inp("fatherName", "Họ tên bố")}${inp("fatherPhone", "SĐT bố", 'inputmode="tel"')}${inp("motherName", "Họ tên mẹ")}${inp("motherPhone", "SĐT mẹ", 'inputmode="tel"')}</div>
    ${inp("note", "Ghi chú")}
    <div class="notice info">Số điện thoại bố/mẹ là tên đăng nhập của phụ huynh. Nếu là số mới, hệ thống tự tạo tài khoản và hiện mật khẩu sau khi lưu.</div>
    <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Huỷ</button><button class="btn" value="ok">Lưu</button></div>`,
    async (fd) => {
      const body = Object.fromEntries(fd);
      const res = await api(s.id ? "PUT" : "POST", s.id ? `/api/students/${s.id}` : "/api/students", body);
      toast("Đã lưu hồ sơ.");
      done();
      if (res.created?.length) {
        setTimeout(() => showSecret("Tài khoản phụ huynh mới", res.created.flatMap((a) => [["Tên đăng nhập (SĐT)", a.phone], ["Mật khẩu", a.password]])), 50);
      }
      return true;
    });
}

function renderImport(area, done) {
  area.innerHTML = `<div class="card"><h2>Nhập hồ sơ học sinh từ Excel</h2>
    <div class="notice info">File cần có dòng tiêu đề với các cột: <b>Mã HS, Họ và tên, Ngày sinh, Giới tính, Lớp, Địa chỉ, Họ tên bố, SĐT bố, Họ tên mẹ, SĐT mẹ, Ghi chú</b>.
      Bắt buộc: <b>Họ và tên</b> và <b>Lớp</b>. Học sinh đã có (trùng Mã HS) sẽ được cập nhật thông tin. Mỗi SĐT bố/mẹ mới sẽ được cấp một tài khoản phụ huynh; nhiều con cùng SĐT sẽ dùng chung một tài khoản.</div>
    <div class="row"><label class="field"><span>Năm học</span><input type="text" id="yr" value="${currentSchoolYear()}" pattern="\\d{4}-\\d{4}" style="width:130px"></label>
      <label class="field grow"><span>File Excel (.xlsx, .xls, .csv)</span><input type="file" id="file" accept=".xlsx,.xls,.csv"></label>
      <button class="btn ghost" id="cancel">Đóng</button></div>
    <div id="preview"></div></div>`;
  $("#cancel", area).onclick = () => (area.innerHTML = "");
  let parsed = null;
  $("#file", area).onchange = (e) => attempt(async () => {
    const f = e.target.files[0];
    if (!f) return;
    parsed = await parseStudentFile(f);
    const labels = Object.fromEntries(STUDENT_FIELDS);
    const missing = STUDENT_FIELDS.filter(([k]) => !parsed.found.includes(k)).map(([, l]) => l);
    $("#preview", area).innerHTML = `
      <p>Đọc được <b>${parsed.rows.length}</b> học sinh từ trang "<b>${esc(parsed.sheet)}</b>". Cột nhận diện: ${parsed.found.map((k) => `<span class="tag ok">${esc(labels[k])}</span>`).join(" ")}
      ${missing.length ? `<br><small class="muted">Không thấy cột: ${missing.map(esc).join(", ")}</small>` : ""}</p>
      ${!parsed.found.includes("className") ? `<div class="notice err">File thiếu cột "Lớp" – bắt buộc để xếp học sinh vào lớp.</div>` : ""}
      <div class="table-wrap" style="max-height:300px"><table><thead><tr>${parsed.found.map((k) => `<th>${esc(labels[k])}</th>`).join("")}</tr></thead>
      <tbody>${parsed.rows.slice(0, 8).map((r) => `<tr>${parsed.found.map((k) => `<td>${esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${parsed.rows.length > 8 ? `<p class="muted">… và ${parsed.rows.length - 8} dòng khác.</p>` : ""}
      <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" id="go">Nhập ${parsed.rows.length} học sinh</button></div>`;
    $("#go", area).onclick = (ev) => attempt(async () => {
      ev.target.textContent = "Đang nhập…";
      const res = await api("POST", "/api/students/import", { schoolYear: $("#yr", area).value.trim(), rows: parsed.rows });
      showImportResult(area, res, done);
    }, ev.target);
  });
}

function showImportResult(area, res, done) {
  const accRows = res.newAccounts.map((a) => [a.phone, a.fullName, a.password, a.students.join("; ")]);
  area.innerHTML = `<div class="card"><h2>Kết quả nhập dữ liệu</h2>
    <div class="notice ok">Đã nhập/cập nhật <b>${res.imported}</b> học sinh trong <b>${res.classesTouched}</b> lớp. Tạo mới <b>${res.newAccounts.length}</b> tài khoản phụ huynh.</div>
    ${res.errors.length ? `<div class="notice err"><b>${res.errors.length} dòng bị bỏ qua:</b><ul>${res.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    ${res.warnings.length ? `<div class="notice warn"><ul>${res.warnings.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
    ${accRows.length ? `<div class="notice warn"><b>Quan trọng:</b> mật khẩu chỉ hiển thị lần này. Hãy tải danh sách về và gửi cho từng phụ huynh. Nếu làm mất, bạn có thể cấp lại mật khẩu ở mục <a href="#/parents">Tài khoản phụ huynh</a>.</div>
      <div class="row" style="margin-bottom:10px"><button class="btn" id="dl">Tải danh sách tài khoản (Excel)</button></div>
      <div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Tên đăng nhập (SĐT)</th><th>Phụ huynh</th><th>Mật khẩu</th><th>Con</th></tr></thead>
      <tbody>${accRows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td><code>${esc(r[2])}</code></td><td>${esc(r[3])}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn ghost" id="close">Đóng</button></div></div>`;
  if (accRows.length) $("#dl", area).onclick = () => attempt(() => downloadXlsx(`EduTrack_tai_khoan_phu_huynh_${new Date().toISOString().slice(0, 10)}.xlsx`,
    [["Tên đăng nhập (SĐT)", "Phụ huynh", "Mật khẩu", "Con"], ...accRows], "TaiKhoan"));
  $("#close", area).onclick = () => done();
}

// ---------- Sổ điểm ----------
// Thông tư 22/2021: ĐTBmhk = (Tổng ĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck) / (Số ĐĐGtx + 5)
function semesterAverage(tx, gk, ck) {
  const t = tx.filter((v) => v !== null && v !== undefined && v !== "");
  if (gk == null || ck == null || !t.length) return null;
  return Math.round(((t.reduce((a, b) => a + Number(b), 0) + 2 * gk + 3 * ck) / (t.length + 5)) * 10) / 10;
}
const fmt = (v) => (v === null || v === undefined ? "" : Number(v).toLocaleString("vi-VN", { maximumFractionDigits: 2 }));

async function viewGrades(page) {
  const options = await api("GET", "/api/gradebook/options");
  if (!options.length) {
    page.innerHTML = head("Sổ điểm") + `<div class="card empty">${me.role === "admin"
      ? `Chưa có lớp nào. Hãy tạo lớp hoặc nhập học sinh trước.` : `Bạn chưa được phân công giảng dạy lớp nào. Vui lòng liên hệ quản trị viên.`}</div>`;
    return;
  }
  const p = hashParams();
  const state = {
    classId: +p.get("classId") || options[0].id,
    subjectId: +p.get("subjectId") || null,
    semester: +p.get("semester") || (new Date().getMonth() < 6 ? 2 : 1), // tháng 1–6: học kỳ II
  };
  if (!options.some((o) => o.id === state.classId)) state.classId = options[0].id;
  page.innerHTML = head("Sổ điểm", "Điểm đánh giá thường xuyên (TX), giữa kỳ (GK), cuối kỳ (CK) theo Thông tư 22.") +
    `<div class="card"><div class="row">
      <label class="field"><span>Lớp</span><select id="g-class">${options.map((o) => `<option value="${o.id}">${esc(o.name)} · ${esc(o.schoolYear)}${o.isHomeroom ? " (chủ nhiệm)" : ""}</option>`).join("")}</select></label>
      <label class="field grow"><span>Môn học</span><select id="g-subj"></select></label>
      <label class="field"><span>Học kỳ</span><select id="g-sem"><option value="1">Học kỳ I</option><option value="2">Học kỳ II</option></select></label>
    </div></div><div id="g-body"></div>`;
  const cSel = $("#g-class"), sSel = $("#g-subj"), semSel = $("#g-sem");
  cSel.value = state.classId; semSel.value = state.semester;
  const fillSubjects = () => {
    const o = options.find((x) => x.id === +cSel.value);
    sSel.innerHTML = o.subjects.length ? o.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}${s.canEdit ? "" : " (chỉ xem)"}</option>`).join("")
      : `<option value="">Chưa có môn học</option>`;
    if (state.subjectId && o.subjects.some((s) => s.id === state.subjectId)) sSel.value = state.subjectId;
  };
  fillSubjects();
  let dirty = false;
  const guard = () => !dirty || window.confirm("Bạn có điểm chưa lưu. Bỏ qua các thay đổi?");
  const load = async () => {
    dirty = false;
    const body = $("#g-body");
    if (!sSel.value) {
      body.innerHTML = `<div class="card empty">${me.role === "admin" ? `Chưa có môn học. Vào mục <a href="#/subjects">Môn học</a> để tạo.` : "Không có môn nào."}</div>`;
      return;
    }
    history.replaceState(null, "", `#/grades?classId=${cSel.value}&subjectId=${sSel.value}&semester=${semSel.value}`);
    body.innerHTML = `<div class="empty">Đang tải…</div>`;
    const data = await api("GET", `/api/grades?classId=${cSel.value}&subjectId=${sSel.value}&semester=${semSel.value}`);
    renderGradeTable(body, data, { classId: +cSel.value, subjectId: +sSel.value, semester: +semSel.value, subjectName: sSel.selectedOptions[0].text }, (d) => (dirty = d));
  };
  let last = { c: cSel.value, s: sSel.value, m: semSel.value };
  const change = (e) => {
    if (!guard()) { cSel.value = last.c; fillSubjects(); sSel.value = last.s; semSel.value = last.m; return; }
    if (e.target === cSel) fillSubjects();
    last = { c: cSel.value, s: sSel.value, m: semSel.value };
    attempt(load);
  };
  cSel.onchange = sSel.onchange = semSel.onchange = change;
  window.onbeforeunload = () => (dirty ? true : undefined);
  await load();
}

function renderGradeTable(body, data, ctx, setDirty) {
  const { students, grades, canEdit } = data;
  const byStudent = new Map(students.map((s) => [s.id, { tx: {}, gk: null, ck: null }]));
  let maxTx = 4;
  for (const g of grades) {
    const r = byStudent.get(g.studentId);
    if (!r) continue;
    if (g.kind === "tx") { r.tx[g.slot] = g.score; maxTx = Math.max(maxTx, g.slot); } else r[g.kind] = g.score;
  }
  let txCount = maxTx;
  const original = new Map(); // key -> value ban đầu
  const key = (sid, kind, slot) => `${sid}:${kind}:${slot}`;
  for (const [sid, r] of byStudent) {
    for (const [slot, v] of Object.entries(r.tx)) original.set(key(sid, "tx", slot), v);
    if (r.gk != null) original.set(key(sid, "gk", 1), r.gk);
    if (r.ck != null) original.set(key(sid, "ck", 1), r.ck);
  }

  if (!students.length) { body.innerHTML = `<div class="card empty">Lớp chưa có học sinh.</div>`; return; }

  const cell = (sid, kind, slot, v) => `<td class="num"><input class="score${v != null && !Number.isNaN(v) && v !== (original.get(key(sid, kind, slot)) ?? null) ? " dirty" : ""}" inputmode="decimal" data-sid="${sid}" data-kind="${kind}" data-slot="${slot}"
      value="${v == null || Number.isNaN(v) ? "" : fmt(v)}" ${canEdit ? "" : "disabled"} aria-label="${kind.toUpperCase()}${kind === "tx" ? slot : ""}"></td>`;
  const draw = () => {
    body.innerHTML = `<div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <div><b>${esc(data.class.name)}</b> · ${esc(ctx.subjectName.replace(" (chỉ xem)", ""))} · Học kỳ ${ctx.semester === 1 ? "I" : "II"} · ${esc(data.class.schoolYear)}
          ${canEdit ? "" : ` <span class="tag">Chỉ xem</span>`}</div>
        <div class="actions">${canEdit ? `<button class="btn ghost small" id="addtx">+ Cột TX</button>` : ""}<button class="btn ghost small" id="xls">${canEdit ? "Xuất Excel / Tải file mẫu" : "Xuất Excel"}</button>
          ${canEdit ? `<button class="btn small" id="imp-grades">Nhập điểm từ Excel</button><input type="file" id="imp-file" accept=".xlsx,.xls,.csv" hidden>` : ""}</div>
      </div>
      ${canEdit ? `<p class="muted" style="margin:0 0 10px;font-size:13px">Nhập điểm từ 0 đến 10 (VD: 8,5). Nhấn Enter để xuống dòng. Có thể dán cả cột điểm từ Excel vào ô đầu tiên.
        <br>Nhập bằng Excel: bấm "Xuất Excel / Tải file mẫu", điền điểm vào các cột TX1, TX2…, GK, CK (giữ nguyên cột Mã HS), rồi bấm "Nhập điểm từ Excel". Điểm được điền vào bảng để bạn kiểm tra trước khi bấm "Lưu điểm".</p>
        <div id="imp-report"></div>` : ""}
      <div class="table-wrap"><table class="gradebook"><thead>
        <tr><th rowspan="2">#</th><th rowspan="2">Họ và tên</th><th class="num grp" colspan="${txCount}">Thường xuyên</th><th class="num grp" rowspan="2">GK</th><th class="num grp" rowspan="2">CK</th><th class="num" rowspan="2">ĐTB HK</th></tr>
        <tr>${Array.from({ length: txCount }, (_, i) => `<th class="num">TX${i + 1}</th>`).join("")}</tr></thead><tbody>
        ${students.map((s, i) => {
          const r = byStudent.get(s.id);
          return `<tr data-row="${s.id}"><td class="muted">${i + 1}</td><td class="name"><b>${esc(s.fullName)}</b><br><small class="muted">${esc(s.dateOfBirth || s.studentCode)}</small></td>
            ${Array.from({ length: txCount }, (_, j) => cell(s.id, "tx", j + 1, r.tx[j + 1])).join("")}
            ${cell(s.id, "gk", 1, r.gk)}${cell(s.id, "ck", 1, r.ck)}<td class="num avg" data-avg="${s.id}"></td></tr>`;
        }).join("")}
      </tbody></table></div>
      ${canEdit ? `<div class="sticky-save"><span class="muted" id="dirty-info"></span><button class="btn" id="save" disabled>Lưu điểm</button></div>` : ""}
    </div>`;
    students.forEach((s) => updateAvg(s.id));
    bind();
  };
  const parseScore = (s) => {
    const t = String(s).trim().replace(",", ".");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 && n <= 10 && /^\d+(\.\d{1,2})?$/.test(t) ? n : NaN;
  };
  const updateAvg = (sid) => {
    const r = byStudent.get(sid);
    const tx = Array.from({ length: txCount }, (_, j) => r.tx[j + 1]).filter((v) => v != null && !Number.isNaN(v));
    const avg = semesterAverage(tx, Number.isNaN(r.gk) ? null : r.gk, Number.isNaN(r.ck) ? null : r.ck);
    $(`[data-avg="${sid}"]`, body).textContent = avg == null ? "" : fmt(avg);
  };
  const changes = () => {
    const out = [];
    for (const [sid, r] of byStudent) {
      const check = (kind, slot, v) => {
        const o = original.get(key(sid, kind, slot));
        if ((v ?? null) !== (o ?? null)) out.push({ studentId: sid, kind, slot, score: v ?? null });
      };
      for (let j = 1; j <= txCount; j++) check("tx", j, r.tx[j]);
      check("gk", 1, r.gk); check("ck", 1, r.ck);
    }
    return out;
  };
  const refreshDirty = () => {
    const ch = changes();
    const bad = $$("input.score.bad", body).length;
    setDirty(ch.length > 0);
    const btn = $("#save", body);
    if (!btn) return;
    btn.disabled = !ch.length || bad > 0;
    $("#dirty-info", body).textContent = bad ? `${bad} ô điểm không hợp lệ` : ch.length ? `${ch.length} thay đổi chưa lưu` : "";
  };
  const setValue = (input, raw) => {
    const sid = +input.dataset.sid, kind = input.dataset.kind, slot = +input.dataset.slot;
    const v = parseScore(raw);
    input.classList.toggle("bad", Number.isNaN(v));
    const r = byStudent.get(sid);
    if (kind === "tx") r.tx[slot] = v; else r[kind] = v;
    input.classList.toggle("dirty", !Number.isNaN(v) && (v ?? null) !== (original.get(key(sid, kind, slot)) ?? null));
    updateAvg(sid);
  };
  const bind = () => {
    const inputs = $$("input.score", body);
    inputs.forEach((input) => {
      input.oninput = () => { setValue(input, input.value); refreshDirty(); };
      input.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const col = inputs.filter((x) => x.dataset.kind === input.dataset.kind && x.dataset.slot === input.dataset.slot);
          const next = col[col.indexOf(input) + (e.key === "ArrowUp" ? -1 : 1)];
          if (next) { next.focus(); next.select(); }
        }
      };
      input.onpaste = (e) => {
        const text = e.clipboardData.getData("text");
        if (!/[\n\t]/.test(text.trim())) return;
        e.preventDefault();
        const lines = text.replace(/\r/g, "").replace(/\n$/, "").split("\n");
        const rowsEls = $$("tr[data-row]", body);
        const startRow = rowsEls.findIndex((tr) => tr.dataset.row === input.dataset.sid);
        const rowInputs = (tr) => $$("input.score", tr);
        const startCol = rowInputs(rowsEls[startRow]).indexOf(input);
        lines.forEach((line, i) => {
          const tr = rowsEls[startRow + i];
          if (!tr) return;
          line.split("\t").forEach((val, j) => {
            const target = rowInputs(tr)[startCol + j];
            if (target) { target.value = val.trim(); setValue(target, val); }
          });
        });
        refreshDirty();
      };
    });
    const add = $("#addtx", body);
    if (add) add.onclick = () => {
      if (txCount >= 10) return toast("Tối đa 10 cột thường xuyên.", true);
      // Giữ lại giá trị đang nhập khi vẽ lại bảng.
      txCount++; draw(); refreshDirty();
    };
    const save = $("#save", body);
    if (save) save.onclick = () => attempt(async () => {
      const ch = changes();
      await api("PUT", "/api/grades", { classId: ctx.classId, subjectId: ctx.subjectId, semester: ctx.semester, entries: ch });
      for (const c of ch) { if (c.score == null) original.delete(key(c.studentId, c.kind, c.slot)); else original.set(key(c.studentId, c.kind, c.slot), c.score); }
      $$("input.score.dirty", body).forEach((x) => x.classList.remove("dirty"));
      refreshDirty();
      toast(`Đã lưu ${ch.length} thay đổi.`);
    }, save);
    const impBtn = $("#imp-grades", body), impFile = $("#imp-file", body);
    if (impBtn) {
      impBtn.onclick = () => impFile.click();
      impFile.onchange = () => attempt(async () => {
        const f = impFile.files[0];
        impFile.value = "";
        if (f) importGradesFromFile(f);
      }, impBtn);
    }
    $("#xls", body).onclick = () => attempt(() => downloadXlsx(
      `So_diem_${data.class.name}_${ctx.subjectName.replace(" (chỉ xem)", "")}_HK${ctx.semester}.xlsx`.replace(/[\\/:*?"<>|\s]+/g, "_"),
      [["STT", "Mã HS", "Họ và tên", ...Array.from({ length: txCount }, (_, i) => `TX${i + 1}`), "GK", "CK", "ĐTB HK"],
        ...students.map((s, i) => {
          const r = byStudent.get(s.id);
          const tx = Array.from({ length: txCount }, (_, j) => r.tx[j + 1] ?? "");
          return [i + 1, s.studentCode, s.fullName, ...tx, r.gk ?? "", r.ck ?? "", semesterAverage(tx, r.gk, r.ck) ?? ""];
        })], "SoDiem"));
  };
  // Đọc file Excel điểm: khớp học sinh theo Mã HS (hoặc họ tên nếu không có mã), điền vào bảng để kiểm tra rồi lưu.
  async function importGradesFromFile(file) {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer());
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
    let hIdx = -1, cols = null;
    for (let i = 0; i < Math.min(20, aoa.length); i++) {
      const m = { tx: {} };
      aoa[i].forEach((h, c) => {
        const n = normHeader(h);
        let mt;
        if (HEADER_ALIASES.studentCode.includes(n)) m.code ??= c;
        else if (HEADER_ALIASES.fullName.includes(n)) m.name ??= c;
        else if ((mt = n.match(/^(?:tx|ddgtx|thuongxuyen)(\d{1,2})$/))) m.tx[+mt[1]] ??= c;
        else if (["gk", "giuaky", "giuaki", "ddggk", "diemgiuaky"].includes(n)) m.gk ??= c;
        else if (["ck", "cuoiky", "cuoiki", "ddgck", "diemcuoiky"].includes(n)) m.ck ??= c;
      });
      if ((m.code !== undefined || m.name !== undefined) && (Object.keys(m.tx).length || m.gk !== undefined || m.ck !== undefined)) { hIdx = i; cols = m; break; }
    }
    if (hIdx < 0) throw new Error('Không tìm thấy dòng tiêu đề. File cần có cột "Mã HS" hoặc "Họ và tên" và các cột điểm TX1, TX2…, GK, CK.');
    const slots = Object.keys(cols.tx).map(Number).filter((n) => n >= 1 && n <= 10);
    const byCode = new Map(students.map((s) => [normHeader(s.studentCode), s]));
    const nameCount = new Map();
    students.forEach((s) => nameCount.set(normHeader(s.fullName), (nameCount.get(normHeader(s.fullName)) || 0) + 1));
    const byName = new Map(students.map((s) => [normHeader(s.fullName), s]));
    const problems = [];
    let filled = 0, matched = 0;
    const seen = new Set();
    for (let i = hIdx + 1; i < aoa.length; i++) {
      const r = aoa[i], line = i + 1;
      const code = cols.code !== undefined ? normHeader(r[cols.code]) : "";
      const name = cols.name !== undefined ? normHeader(r[cols.name]) : "";
      if (!code && !name) continue;
      let st = code ? byCode.get(code) : null;
      if (!st && name) {
        if (nameCount.get(name) > 1) { problems.push(`Dòng ${line}: có nhiều học sinh trùng tên "${cellText(r[cols.name])}" – cần cột Mã HS.`); continue; }
        st = byName.get(name);
      }
      if (!st) { problems.push(`Dòng ${line}: không tìm thấy học sinh "${cellText(r[cols.name] ?? r[cols.code])}" trong lớp.`); continue; }
      if (seen.has(st.id)) { problems.push(`Dòng ${line}: học sinh ${st.fullName} xuất hiện nhiều lần, chỉ lấy dòng đầu.`); continue; }
      seen.add(st.id); matched++;
      const rec = byStudent.get(st.id);
      const take = (col, label, apply) => {
        if (col === undefined) return;
        const raw = cellText(r[col]);
        if (raw === "") return; // ô trống: giữ nguyên điểm đang có
        const v = parseScore(typeof r[col] === "number" ? String(Math.round(r[col] * 100) / 100) : raw);
        if (Number.isNaN(v)) { problems.push(`Dòng ${line} (${st.fullName}), cột ${label}: "${raw}" không phải điểm hợp lệ (0–10).`); return; }
        apply(v); filled++;
      };
      for (const sl of slots) take(cols.tx[sl], `TX${sl}`, (v) => (rec.tx[sl] = v));
      take(cols.gk, "GK", (v) => (rec.gk = v));
      take(cols.ck, "CK", (v) => (rec.ck = v));
    }
    if (slots.length) txCount = Math.max(txCount, ...slots);
    draw();
    refreshDirty();
    const rep = $("#imp-report", body);
    const notInFile = students.length - matched;
    rep.innerHTML = `<div class="notice ${filled ? "ok" : "warn"}">Đã đọc file "<b>${esc(file.name)}</b>": điền <b>${filled}</b> ô điểm cho <b>${matched}</b> học sinh.
      ${notInFile > 0 ? `${notInFile} học sinh không có trong file (giữ nguyên điểm).` : ""} Các ô màu vàng là điểm mới – hãy kiểm tra rồi bấm <b>Lưu điểm</b>.
      ${problems.length ? `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</div>`;
    toast(filled ? `Đã điền ${filled} ô điểm từ Excel. Nhớ bấm "Lưu điểm".` : "Không có điểm nào được điền.", !filled);
  }
  draw();
  refreshDirty();
}

// ---------- Giáo viên & phân công ----------
async function viewTeachers(page) {
  const [teachers, classList, subjectList, assigns] = await Promise.all([
    api("GET", "/api/teachers"), api("GET", "/api/classes"), api("GET", "/api/subjects"), api("GET", "/api/assignments"),
  ]);
  const years = [...new Set(classList.map((c) => c.schoolYear))];
  page.innerHTML = head("Giáo viên & phân công", "Cấp tài khoản cho giáo viên và phân công lớp – môn được phép nhập điểm.", `<button class="btn" id="add">+ Thêm giáo viên</button>`) +
    `<div class="card"><h2>Danh sách giáo viên <small>${teachers.filter((t) => t.role === "teacher").length} giáo viên</small></h2>
    ${teachers.length ? `<div class="table-wrap"><table><thead><tr><th>Họ và tên</th><th>Tên đăng nhập</th><th>Trạng thái</th><th>Phân công</th><th></th></tr></thead><tbody>
      ${teachers.map((t) => {
        const mine = assigns.filter((a) => a.teacherId === t.id);
        const isAdmin = t.role === "admin";
        return `<tr><td><b>${esc(t.fullName)}</b>${isAdmin ? ` <span class="tag brand">Quản trị viên</span>` : ""}</td><td>${esc(t.username)}</td>
        <td>${t.isActive ? `<span class="tag ok">Hoạt động</span>` : `<span class="tag off">Đã khoá</span>`}</td>
        <td>${mine.length ? mine.map((a) => `<span class="tag brand">${esc(a.className)} · ${esc(a.subjectName)} <button class="btn link small" data-unassign="${a.id}" title="Bỏ phân công">✕</button></span>`).join(" ") : `<span class="muted">Chưa phân công</span>`}</td>
        <td><div class="actions"><button class="btn ghost small" data-assign="${t.id}">Phân công</button>${isAdmin ? "" : `<button class="btn ghost small" data-edit="${t.id}">Sửa</button>
        <button class="btn ghost small" data-reset="${t.id}">Cấp lại mật khẩu</button><button class="btn danger small" data-del="${t.id}">Xoá</button>`}</div></td></tr>`;
      }).join("")}</tbody></table></div>` : `<div class="empty">Chưa có giáo viên nào.</div>`}</div>
    <div class="notice info">Quản trị viên cũng có trong danh sách: có thể phân công dạy môn và đặt làm <b>giáo viên chủ nhiệm</b> (ở mục Quản lý lớp). Giáo viên <b>bộ môn</b> chỉ nhập được điểm môn được phân công. Giáo viên <b>chủ nhiệm</b> (đặt ở mục Quản lý lớp) xem được điểm tất cả các môn của lớp mình.</div>`;

  $("#add").onclick = () => openModal(`<h2>Thêm giáo viên</h2>
    <label class="field"><span>Họ và tên</span><input type="text" name="fullName" required></label>
    <label class="field"><span>Tên đăng nhập (chữ không dấu, số, dấu chấm)</span><input type="text" name="username" required pattern="[A-Za-z0-9._\\-]{3,50}" placeholder="VD: lan.nguyen"></label>
    <p class="muted" style="margin:0">Mật khẩu được tạo ngẫu nhiên và hiển thị sau khi lưu.</p>
    <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Huỷ</button><button class="btn" value="ok">Tạo tài khoản</button></div>`,
    async (fd) => {
      const res = await api("POST", "/api/teachers", Object.fromEntries(fd));
      viewTeachers(page);
      setTimeout(() => showSecret("Tài khoản giáo viên", [["Tên đăng nhập", res.username], ["Mật khẩu", res.password]]), 50);
      return true;
    });

  page.onclick = async (e) => {
    const t = (attr) => { const el = e.target.closest(`[${attr}]`); return el ? +el.getAttribute(attr) : null; };
    let id;
    if ((id = t("data-unassign"))) return attempt(async () => { await api("DELETE", `/api/assignments/${id}`); viewTeachers(page); });
    if ((id = t("data-edit"))) {
      const x = teachers.find((y) => y.id === id);
      return openModal(`<h2>Sửa giáo viên</h2>
        <label class="field"><span>Họ và tên</span><input type="text" name="fullName" required value="${esc(x.fullName)}"></label>
        <label class="row" style="gap:8px;align-items:center"><input type="checkbox" name="isActive" ${x.isActive ? "checked" : ""}> Cho phép đăng nhập</label>
        <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Huỷ</button><button class="btn" value="ok">Lưu</button></div>`,
        async (fd) => { await api("PUT", `/api/teachers/${id}`, { fullName: fd.get("fullName"), isActive: fd.get("isActive") === "on" }); viewTeachers(page); return true; });
    }
    if ((id = t("data-reset"))) {
      const x = teachers.find((y) => y.id === id);
      if (await confirmBox(`Cấp mật khẩu mới cho ${x.fullName}? Mật khẩu cũ sẽ không dùng được nữa.`, "Cấp lại"))
        attempt(async () => { const r = await api("POST", `/api/users/${id}/reset-password`, {}); showSecret("Mật khẩu mới", [["Tên đăng nhập", r.username], ["Mật khẩu", r.password]]); });
      return;
    }
    if ((id = t("data-del"))) {
      const x = teachers.find((y) => y.id === id);
      if (await confirmBox(`Xoá tài khoản giáo viên ${x.fullName}? Các phân công của giáo viên cũng bị xoá. Điểm đã nhập vẫn được giữ.`))
        attempt(async () => { await api("DELETE", `/api/users/${id}`); viewTeachers(page); });
      return;
    }
    if ((id = t("data-assign"))) {
      const x = teachers.find((y) => y.id === id);
      if (!subjectList.length) return toast("Chưa có môn học. Hãy tạo môn học trước.", true);
      if (!classList.length) return toast("Chưa có lớp. Hãy tạo lớp trước.", true);
      openModal(`<h2>Phân công: ${esc(x.fullName)}</h2>
        <label class="field"><span>Môn học</span><select name="subjectId" required>${subjectList.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label>
        <label class="field"><span>Năm học</span><select id="as-year">${years.map((y) => `<option>${esc(y)}</option>`).join("")}</select></label>
        <div class="field"><span>Các lớp dạy</span><div class="checks" id="as-classes"></div></div>
        <div class="actions"><button class="btn ghost" value="cancel" formnovalidate>Huỷ</button><button class="btn" value="ok">Phân công</button></div>`,
        async (fd) => {
          const classIds = fd.getAll("classIds");
          if (!classIds.length) throw new Error("Chọn ít nhất một lớp.");
          await api("POST", "/api/assignments", { teacherId: id, subjectId: fd.get("subjectId"), classIds });
          toast("Đã phân công."); viewTeachers(page); return true;
        });
      const fill = () => ($("#as-classes").innerHTML = classList.filter((c) => c.schoolYear === $("#as-year").value)
        .map((c) => `<label><input type="checkbox" name="classIds" value="${c.id}"> ${esc(c.name)}</label>`).join(""));
      $("#as-year").onchange = fill; fill();
    }
  };
}

// ---------- Tài khoản phụ huynh ----------
// Cấp lại mật khẩu cho nhiều phụ huynh, hiện kết quả và tải danh sách Excel.
async function bulkResetParents(payload, count, what, done) {
  if (!(await confirmBox(`Cấp mật khẩu mới cho ${what}? Mật khẩu cũ sẽ không dùng được nữa. Mật khẩu mới theo dạng tên con + ngày sinh (VD: bang2103).`, "Cấp lại")))
    return;
  await attempt(async () => {
    const r = await api("POST", "/api/parents/reset-passwords", payload);
    const rows = r.updated.map((a) => [a.phone, a.fullName, a.password, a.students.join("; ")]);
    const header = ["Tên đăng nhập (SĐT)", "Phụ huynh", "Mật khẩu", "Con"];
    const file = `EduTrack_cap_lai_mat_khau_${new Date().toISOString().slice(0, 10)}.xlsx`;
    done();
    openModal(`<h2>Đã cấp lại ${rows.length} mật khẩu</h2>
      <div class="notice warn">Mật khẩu chỉ hiển thị lần này. Hãy tải danh sách về và gửi cho từng phụ huynh.</div>
      <div class="table-wrap" style="max-height:340px"><table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((x) => `<tr><td>${esc(x[0])}</td><td>${esc(x[1])}</td><td><code>${esc(x[2])}</code></td><td>${esc(x[3])}</td></tr>`).join("")}</tbody></table></div>
      <div class="actions"><button type="button" class="btn ghost" id="bulk-dl">Tải danh sách (Excel)</button><button class="btn" value="ok">Đóng</button></div>`);
    $("#bulk-dl").onclick = () => attempt(() => downloadXlsx(file, [header, ...rows], "TaiKhoan"));
  });
}

async function viewParents(page) {
  const list = await api("GET", "/api/parents");
  const selected = new Set();
  page.innerHTML = head("Tài khoản phụ huynh", "Tài khoản được tạo tự động từ SĐT bố/mẹ trong hồ sơ học sinh. Mật khẩu mặc định: tên con (không dấu) + ngày, tháng sinh – VD: Hà Văn Bằng, 21/03/2015 → bang2103.",
    `<button class="btn ghost" id="easy">Đặt mật khẩu dễ nhớ cho phụ huynh chưa đổi mật khẩu</button>`) +
    `<div class="card"><div class="row" style="margin-bottom:12px"><label class="field grow"><span>Tìm kiếm</span><input type="search" id="q" placeholder="SĐT, tên phụ huynh hoặc tên con…"></label></div><div id="tbl"></div></div>`;
  const draw = () => {
    const q = normHeader($("#q").value);
    const rows = list.filter((p) => !q || normHeader(`${p.username} ${p.fullName} ${p.children}`).includes(q));
    const allOn = rows.length > 0 && rows.every((p) => selected.has(p.id));
    $("#tbl").innerHTML = rows.length ? `<div class="row" style="margin:0 0 8px;justify-content:space-between;align-items:center">
      <span class="muted">${rows.length} tài khoản · <b id="sel-count">${selected.size}</b> đã chọn</span>
      <div class="actions"><button class="btn ghost small" id="sel-clear" ${selected.size ? "" : "disabled"}>Bỏ chọn</button>
      <button class="btn small" id="sel-reset" ${selected.size ? "" : "disabled"}>Cấp lại mật khẩu cho ${selected.size} tài khoản đã chọn</button></div></div><div class="table-wrap"><table>
      <thead><tr><th><input type="checkbox" id="sel-all" ${allOn ? "checked" : ""} title="Chọn tất cả"></th><th>Tên đăng nhập (SĐT)</th><th>Phụ huynh</th><th>Con</th><th>Trạng thái</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td><input type="checkbox" data-sel="${p.id}" ${selected.has(p.id) ? "checked" : ""}></td><td class="nowrap"><b>${esc(p.username)}</b></td><td>${esc(p.fullName)}</td><td>${esc(p.children) || `<span class="muted">—</span>`}</td>
        <td>${!p.isActive ? `<span class="tag off">Đã khoá</span>` : p.mustChangePassword ? `<span class="tag">Chưa đổi mật khẩu</span>` : `<span class="tag ok">Đã đổi mật khẩu</span>`}</td>
        <td><div class="actions"><button class="btn ghost small" data-reset="${p.id}">Cấp lại mật khẩu</button>
        <button class="btn ghost small" data-toggle="${p.id}">${p.isActive ? "Khoá" : "Mở khoá"}</button><button class="btn danger small" data-del="${p.id}">Xoá</button></div></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">Chưa có tài khoản phụ huynh. Tài khoản sẽ được tạo khi bạn nhập hồ sơ học sinh có SĐT bố/mẹ.</div>`;
    if (!rows.length) return;
    $("#sel-all").onchange = (e) => { rows.forEach((p) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id))); draw(); };
    $$("[data-sel]").forEach((cb) => (cb.onchange = () => { cb.checked ? selected.add(+cb.dataset.sel) : selected.delete(+cb.dataset.sel); draw(); }));
    $("#sel-clear").onclick = () => { selected.clear(); draw(); };
    $("#sel-reset").onclick = () => bulkResetParents({ parentIds: [...selected] }, selected.size, `${selected.size} tài khoản phụ huynh đã chọn`, () => viewParents(page));
  };
  draw();
  $("#q").oninput = draw;
  $("#easy").onclick = async () => {
    if (!(await confirmBox("Đặt lại mật khẩu của tất cả phụ huynh CHƯA tự đổi mật khẩu theo dạng tên con + ngày sinh (VD: bang2103)? Phụ huynh đã tự đổi mật khẩu sẽ không bị ảnh hưởng.", "Đồng ý")))
      return;
    attempt(async () => {
      const r = await api("POST", "/api/parents/easy-passwords", {});
      const rows = r.updated.map((a) => [a.phone, a.fullName, a.password, a.students.join("; ")]);
      if (rows.length) await downloadXlsx(`EduTrack_mat_khau_phu_huynh_${new Date().toISOString().slice(0, 10)}.xlsx`,
        [["Tên đăng nhập (SĐT)", "Phụ huynh", "Mật khẩu", "Con"], ...rows], "TaiKhoan");
      toast(`Đã đặt lại ${rows.length} tài khoản${r.skipped ? `, bỏ qua ${r.skipped} tài khoản do con thiếu ngày sinh` : ""}. Danh sách đã được tải về.`);
      viewParents(page);
    });
  };
  page.onclick = async (e) => {
    const get = (a) => { const el = e.target.closest(`[${a}]`); return el ? list.find((p) => p.id === +el.getAttribute(a)) : null; };
    let p;
    if ((p = get("data-reset"))) {
      if (await confirmBox(`Cấp mật khẩu mới cho tài khoản ${p.username}?`, "Cấp lại"))
        attempt(async () => { const r = await api("POST", `/api/users/${p.id}/reset-password`, {}); showSecret("Mật khẩu mới cho phụ huynh", [["Tên đăng nhập (SĐT)", r.username], ["Mật khẩu", r.password]]); viewParents(page); });
    } else if ((p = get("data-toggle"))) {
      attempt(async () => { await api("PUT", `/api/parents/${p.id}`, { isActive: !p.isActive }); viewParents(page); });
    } else if ((p = get("data-del"))) {
      if (await confirmBox(`Xoá tài khoản ${p.username}? Nếu SĐT vẫn còn trong hồ sơ học sinh, tài khoản sẽ được tạo lại khi bạn nhập/sửa hồ sơ.`))
        attempt(async () => { await api("DELETE", `/api/users/${p.id}`); viewParents(page); });
    }
  };
}

// ---------- Môn học ----------
async function viewSubjects(page) {
  const list = await api("GET", "/api/subjects");
  page.innerHTML = head("Môn học", "Danh sách môn dùng cho sổ điểm và phân công giảng dạy.") +
    `<div class="card"><form class="row" id="f" style="margin-bottom:14px"><label class="field grow"><span>Tên môn mới</span><input type="text" name="name" required></label><button class="btn">Thêm môn</button>
      ${list.length ? "" : `<button type="button" class="btn ghost" id="defaults">Tạo danh sách môn THCS (CT GDPT 2018)</button>`}</form>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Môn học</th><th></th></tr></thead><tbody>
      ${list.map((s, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(s.name)}</td><td><div class="actions"><button class="btn danger small" data-del="${s.id}">Xoá</button></div></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">Chưa có môn học.</div>`}</div>
    <div class="notice info">Một số môn đánh giá bằng nhận xét (Đạt/Chưa đạt) như Giáo dục thể chất, Nghệ thuật, HĐTN-HN: phiên bản hiện tại nhập dạng điểm số; bạn có thể bỏ qua các môn này trong sổ điểm.</div>`;
  $("#f").onsubmit = (e) => { e.preventDefault(); attempt(async () => { await api("POST", "/api/subjects", Object.fromEntries(new FormData(e.target))); viewSubjects(page); }, e.submitter); };
  const d = $("#defaults");
  if (d) d.onclick = () => attempt(async () => { await api("POST", "/api/subjects/defaults", {}); viewSubjects(page); }, d);
  page.onclick = async (e) => {
    const el = e.target.closest("[data-del]");
    if (!el) return;
    const s = list.find((x) => x.id === +el.dataset.del);
    if (await confirmBox(`Xoá môn ${s.name}? (Chỉ xoá được khi môn chưa có điểm.)`))
      attempt(async () => { await api("DELETE", `/api/subjects/${s.id}`); viewSubjects(page); });
  };
}

// ---------- Phụ huynh xem điểm ----------
async function viewResults(page) {
  const kids = await api("GET", "/api/my-children");
  if (!kids.length) {
    page.innerHTML = head("Kết quả học tập") + `<div class="card empty">Tài khoản chưa được liên kết với học sinh nào. Vui lòng liên hệ nhà trường.</div>`;
    return;
  }
  let current = +hashParams().get("student") || kids[0].id;
  if (!kids.some((k) => k.id === current)) current = kids[0].id;
  page.innerHTML = head("Kết quả học tập", "Điểm được giáo viên cập nhật trực tiếp trên hệ thống.") +
    (kids.length > 1 ? `<div class="kids">${kids.map((k) => `<button class="kid" data-kid="${k.id}"><b>${esc(k.fullName)}</b><small>Lớp ${esc(k.className || "—")}</small></button>`).join("")}</div>` : "") +
    `<div id="r-body"></div>`;
  const show = async () => {
    $$(".kid").forEach((b) => b.classList.toggle("active", +b.dataset.kid === current));
    const kid = kids.find((k) => k.id === current);
    const data = await api("GET", `/api/my-children/${current}/grades`);
    const years = [...new Set([kid.schoolYear, ...data.grades.map((g) => g.schoolYear)].filter(Boolean))].sort().reverse();
    const body = $("#r-body");
    body.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between">
        <div><h2 style="margin:0">${esc(kid.fullName)}</h2><p class="muted" style="margin:4px 0 0">Mã HS: ${esc(kid.studentCode)} · Lớp ${esc(kid.className || "—")}${kid.dateOfBirth ? ` · Ngày sinh ${esc(kid.dateOfBirth)}` : ""}</p></div>
        ${years.length ? `<label class="field"><span>Năm học</span><select id="r-year">${years.map((y) => `<option>${esc(y)}</option>`).join("")}</select></label>` : ""}
      </div></div><div id="r-table"></div>`;
    const drawYear = () => {
      const year = $("#r-year")?.value;
      const g = data.grades.filter((x) => x.schoolYear === year);
      if (!g.length) { $("#r-table").innerHTML = `<div class="card empty">Chưa có điểm trong năm học này.</div>`; return; }
      const cellsFor = (sid, sem) => {
        const items = g.filter((x) => x.subjectId === sid && x.semester === sem);
        const tx = items.filter((x) => x.kind === "tx").sort((a, b) => a.slot - b.slot).map((x) => x.score);
        const gk = items.find((x) => x.kind === "gk")?.score ?? null, ck = items.find((x) => x.kind === "ck")?.score ?? null;
        return { tx, gk, ck, avg: semesterAverage(tx, gk, ck), any: items.length > 0 };
      };
      const subj = data.subjects.filter((s) => g.some((x) => x.subjectId === s.id));
      const semTable = (sem) => {
        const rows = subj.map((s) => ({ s, c: cellsFor(s.id, sem) })).filter((r) => r.c.any);
        if (!rows.length) return `<div class="card"><h2>Học kỳ ${sem === 1 ? "I" : "II"}</h2><div class="empty">Chưa có điểm.</div></div>`;
        return `<div class="card"><h2>Học kỳ ${sem === 1 ? "I" : "II"}</h2><div class="table-wrap"><table>
          <thead><tr><th>Môn học</th><th>Thường xuyên</th><th class="num">Giữa kỳ</th><th class="num">Cuối kỳ</th><th class="num">ĐTB môn</th></tr></thead><tbody>
          ${rows.map(({ s, c }) => `<tr><td><b>${esc(s.name)}</b></td><td>${c.tx.map(fmt).join(" &nbsp; ") || `<span class="muted">—</span>`}</td>
            <td class="num">${fmt(c.gk)}</td><td class="num">${fmt(c.ck)}</td><td class="num"><b style="color:var(--brand)">${fmt(c.avg)}</b></td></tr>`).join("")}
          </tbody></table></div></div>`;
      };
      const yearRows = subj.map((s) => {
        const a1 = cellsFor(s.id, 1).avg, a2 = cellsFor(s.id, 2).avg;
        return { s, a1, a2, cn: a1 != null && a2 != null ? Math.round(((a1 + 2 * a2) / 3) * 10) / 10 : null };
      }).filter((r) => r.a1 != null || r.a2 != null);
      $("#r-table").innerHTML = semTable(1) + semTable(2) + (yearRows.length ? `<div class="card"><h2>Tổng kết năm <small>ĐTB cả năm = (HKI + 2 × HKII) / 3</small></h2><div class="table-wrap"><table>
        <thead><tr><th>Môn học</th><th class="num">HK I</th><th class="num">HK II</th><th class="num">Cả năm</th></tr></thead><tbody>
        ${yearRows.map((r) => `<tr><td><b>${esc(r.s.name)}</b></td><td class="num">${fmt(r.a1)}</td><td class="num">${fmt(r.a2)}</td><td class="num"><b style="color:var(--brand)">${fmt(r.cn)}</b></td></tr>`).join("")}
        </tbody></table></div></div>` : "");
    };
    if ($("#r-year")) { $("#r-year").onchange = drawYear; drawYear(); } else $("#r-table").innerHTML = `<div class="card empty">Chưa có điểm.</div>`;
  };
  page.onclick = (e) => {
    const b = e.target.closest("[data-kid]");
    if (b) { current = +b.dataset.kid; attempt(show); }
  };
  await show();
}

boot();
