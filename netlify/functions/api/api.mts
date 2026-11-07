import type { Config } from "@netlify/functions";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../../db/index.js";
import {
  classes, grades, parentStudents, sessions, students, subjects, teacherAssignments, users,
} from "../../../db/schema.js";
import {
  clearCookie, createSession, destroySession, getSessionUser, hashPassword, normalizePhone,
  randomPassword, verifyPassword, easyParentPassword, type SessionUser,
} from "./auth.js";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, init);

type Ctx = { req: Request; user: SessionUser | null; params: Record<string, string>; body: any; url: URL };
type Handler = (c: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "(\\d+)"; }) + "/?$");
  routes.push({ method, pattern, keys, handler });
}

const requireUser = (c: Ctx) => c.user ?? fail(401, "Bạn cần đăng nhập.");

// Quản trị viên: Quản trị hệ thống (admin) hoặc giáo viên được phân quyền quản trị (canManage)
const requireAdmin = (c: Ctx) => {
  const u = requireUser(c);
  if (u.role !== "admin" && !u.canManage) fail(403, "Bạn không có quyền quản trị này.");
  return u;
};

// Quản trị hệ thống cao nhất: chỉ tài khoản admin gốc
const requireSuperAdmin = (c: Ctx) => {
  const u = requireUser(c);
  if (u.role !== "admin" && !u.isSuperAdmin) fail(403, "Chỉ Quản trị hệ thống mới có quyền này.");
  return u;
};

const str = (v: unknown, max = 200) => (v === null || v === undefined ? "" : String(v).trim().slice(0, max));
const optStr = (v: unknown, max = 500) => str(v, max) || null;
const intParam = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fail(400, "Tham số không hợp lệ.");
};
function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const MIN_PASSWORD = 6;
const checkNewPassword = (pw: unknown) => {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD || pw.length > 100)
    fail(400, `Mật khẩu phải có ít nhất ${MIN_PASSWORD} ký tự.`);
  return pw as string;
};

// Chuẩn hoá điểm nhận xét (Đạt / Chưa đạt)
function parseCommentGrade(raw: unknown): { score: string; scoreText: string } | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d");
  if (s === "1" || s === "d" || s === "dat") {
    return { score: "1.00", scoreText: "Đ" };
  }
  if (s === "0" || s === "cd" || s === "chua dat") {
    return { score: "0.00", scoreText: "CĐ" };
  }
  fail(400, `Giá trị "${raw}" không hợp lệ cho môn nhận xét (chỉ nhận Đ/1/Đạt hoặc CĐ/0/Chưa đạt).`);
}

// ---------- Khởi tạo & đăng nhập ----------

route("GET", "/api/setup-status", async () => {
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  return json({ needsSetup: admins.length === 0 });
});

route("POST", "/api/setup", async (c) => {
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (admins.length) fail(409, "Hệ thống đã có tài khoản Quản trị hệ thống.");
  const username = str(c.body.username, 50).toLowerCase();
  const fullName = str(c.body.fullName, 100);
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) fail(400, "Tên đăng nhập 3–50 ký tự, chỉ gồm chữ không dấu, số, dấu . _ -");
  const password = checkNewPassword(c.body.password);
  const [u] = await db.insert(users).values({
    username, fullName: fullName || "Quản trị hệ thống", role: "admin",
    canManage: true, isSuperAdmin: true,
    passwordHash: await hashPassword(password), mustChangePassword: false,
  }).returning({ id: users.id });
  return json({ ok: true }, { headers: { "Set-Cookie": await createSession(u.id) } });
});

route("POST", "/api/login", async (c) => {
  const raw = str(c.body.username, 50);
  const username = normalizePhone(raw) && /^[\d\s.+()-]+$/.test(raw) ? normalizePhone(raw)! : raw.toLowerCase();
  const password = typeof c.body.password === "string" ? c.body.password : "";
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const wrong = "Tên đăng nhập hoặc mật khẩu không đúng.";
  if (!u || !u.isActive) fail(401, wrong);
  if (u.lockedUntil && u.lockedUntil > new Date())
    fail(429, "Tài khoản tạm khoá do nhập sai nhiều lần. Vui lòng thử lại sau 15 phút.");
  if (!(await verifyPassword(password, u.passwordHash))) {
    const attempts = u.failedAttempts + 1;
    await db.update(users).set({
      failedAttempts: attempts >= 5 ? 0 : attempts,
      lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null,
    }).where(eq(users.id, u.id));
    fail(401, wrong);
  }
  await db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, u.id));
  return json({ ok: true }, { headers: { "Set-Cookie": await createSession(u.id) } });
});

route("POST", "/api/logout", async (c) => {
  await destroySession(c.req);
  return json({ ok: true }, { headers: { "Set-Cookie": clearCookie() } });
});

route("GET", "/api/me", async (c) => json({ user: c.user }));

route("POST", "/api/change-password", async (c) => {
  const me = requireUser(c);
  const [u] = await db.select().from(users).where(eq(users.id, me.id));
  if (!(await verifyPassword(String(c.body.oldPassword ?? ""), u.passwordHash))) fail(400, "Mật khẩu hiện tại không đúng.");
  const pw = checkNewPassword(c.body.newPassword);
  await db.update(users).set({ passwordHash: await hashPassword(pw), mustChangePassword: false }).where(eq(users.id, me.id));
  await db.delete(sessions).where(eq(sessions.userId, me.id));
  return json({ ok: true }, { headers: { "Set-Cookie": await createSession(me.id) } });
});

// ---------- Lớp học ----------

route("GET", "/api/classes", async (c) => {
  requireAdmin(c);
  const rows = await db.select({
    id: classes.id, name: classes.name, schoolYear: classes.schoolYear, homeroomTeacherId: classes.homeroomTeacherId,
    homeroomTeacherName: users.fullName,
    studentCount: sql<number>`(select count(*)::int from ${students} where ${students.classId} = ${classes.id})`,
  }).from(classes).leftJoin(users, eq(users.id, classes.homeroomTeacherId))
    .orderBy(sql`${classes.schoolYear} desc`, asc(classes.name));
  return json(rows);
});

async function validTeacherId(v: unknown): Promise<number | null> {
  if (v === null || v === undefined || v === "") return null;
  const id = intParam(v);
  const [t] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), inArray(users.role, ["teacher", "admin"]), eq(users.isActive, true)));
  return t ? id : fail(400, "Giáo viên không tồn tại.");
}
const YEAR_RE = /^\d{4}-\d{4}$/;
function classInput(body: any) {
  const name = str(body.name, 30).toUpperCase();
  const schoolYear = str(body.schoolYear, 9);
  if (!name) fail(400, "Vui lòng nhập tên lớp.");
  if (!YEAR_RE.test(schoolYear)) fail(400, "Năm học có dạng 2025-2026.");
  return { name, schoolYear };
}

route("POST", "/api/classes", async (c) => {
  requireAdmin(c);
  const input = classInput(c.body);
  const homeroomTeacherId = await validTeacherId(c.body.homeroomTeacherId);
  const [row] = await db.insert(classes).values({ ...input, homeroomTeacherId }).onConflictDoNothing().returning();
  if (!row) fail(409, "Lớp này đã tồn tại trong năm học.");
  return json(row, { status: 201 });
});

route("PUT", "/api/classes/:id", async (c) => {
  requireAdmin(c);
  const input = classInput(c.body);
  const homeroomTeacherId = await validTeacherId(c.body.homeroomTeacherId);
  try {
    await db.update(classes).set({ ...input, homeroomTeacherId }).where(eq(classes.id, intParam(c.params.id)));
  } catch { fail(409, "Tên lớp bị trùng trong năm học."); }
  return json({ ok: true });
});

route("DELETE", "/api/classes/:id", async (c) => {
  requireAdmin(c);
  await db.delete(classes).where(eq(classes.id, intParam(c.params.id)));
  return json({ ok: true });
});

// ---------- Môn học ----------

const DEFAULT_SUBJECTS = [
  { name: "Ngữ văn", evaluationType: "score" },
  { name: "Toán", evaluationType: "score" },
  { name: "Tiếng Anh", evaluationType: "score" },
  { name: "Giáo dục công dân", evaluationType: "score" },
  { name: "Lịch sử và Địa lí", evaluationType: "score" },
  { name: "Khoa học tự nhiên", evaluationType: "score" },
  { name: "Công nghệ", evaluationType: "score" },
  { name: "Tin học", evaluationType: "score" },
  { name: "Giáo dục thể chất", evaluationType: "comment" },
  { name: "Nghệ thuật", evaluationType: "comment" },
  { name: "Hoạt động trải nghiệm, hướng nghiệp", evaluationType: "comment" },
  { name: "Nội dung giáo dục địa phương", evaluationType: "comment" },
];

route("GET", "/api/subjects", async (c) => {
  requireUser(c);
  return json(await db.select().from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.name)));
});

route("POST", "/api/subjects", async (c) => {
  requireAdmin(c);
  const name = str(c.body.name, 100);
  if (!name) fail(400, "Vui lòng nhập tên môn.");
  const evaluationType = c.body.evaluationType === "comment" ? "comment" : "score";
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${subjects.sortOrder}),0)::int` }).from(subjects);
  const [row] = await db.insert(subjects).values({ name, sortOrder: max + 1, evaluationType }).onConflictDoNothing().returning();
  if (!row) fail(409, "Môn học đã tồn tại.");
  return json(row, { status: 201 });
});

route("POST", "/api/subjects/defaults", async (c) => {
  requireAdmin(c);
  await db.insert(subjects).values(DEFAULT_SUBJECTS.map((s, i) => ({
    name: s.name,
    sortOrder: i + 1,
    evaluationType: s.evaluationType,
  }))).onConflictDoNothing();
  return json({ ok: true });
});

route("DELETE", "/api/subjects/:id", async (c) => {
  requireAdmin(c);
  const id = intParam(c.params.id);
  const [g] = await db.select({ id: grades.id }).from(grades).where(eq(grades.subjectId, id)).limit(1);
  if (g) fail(409, "Môn này đã có điểm, không thể xoá.");
  await db.delete(subjects).where(eq(subjects.id, id));
  return json({ ok: true });
});

// ---------- Giáo viên & phân công ----------

route("GET", "/api/teachers", async (c) => {
  requireAdmin(c);
  return json(await db.select({
    id: users.id, username: users.username, fullName: users.fullName, isActive: users.isActive,
    role: users.role, canManage: users.canManage, isSuperAdmin: users.isSuperAdmin,
  }).from(users).where(inArray(users.role, ["teacher", "admin"])).orderBy(sql`${users.role} = 'admin' desc`, asc(users.fullName)));
});

route("POST", "/api/teachers", async (c) => {
  requireAdmin(c);
  const username = str(c.body.username, 50).toLowerCase();
  const fullName = str(c.body.fullName, 100);
  if (!fullName) fail(400, "Vui lòng nhập họ tên giáo viên.");
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) fail(400, "Tên đăng nhập 3–50 ký tự, chỉ gồm chữ không dấu, số, dấu . _ -");
  if (/^\d{10}$/.test(username)) fail(400, "Tên đăng nhập giáo viên không nên là số điện thoại (dành cho phụ huynh).");
  const canManage = Boolean(c.body.canManage);
  const password = randomPassword();
  const [row] = await db.insert(users).values({
    username, fullName, role: "teacher", canManage, passwordHash: await hashPassword(password),
  }).onConflictDoNothing().returning({ id: users.id });
  if (!row) fail(409, "Tên đăng nhập đã được sử dụng.");
  return json({ id: row.id, username, password }, { status: 201 });
});

route("PUT", "/api/teachers/:id", async (c) => {
  const me = requireAdmin(c);
  const id = intParam(c.params.id);
  const fullName = str(c.body.fullName, 100);
  if (!fullName) fail(400, "Vui lòng nhập họ tên.");

  const [target] = await db.select({ role: users.role, isSuperAdmin: users.isSuperAdmin }).from(users).where(eq(users.id, id));
  if (!target) fail(404, "Không tìm thấy người dùng.");
  if (target.isSuperAdmin && !me.isSuperAdmin) fail(403, "Không thể sửa Quản trị hệ thống.");

  const updateData: Record<string, any> = { fullName, isActive: c.body.isActive !== false };
  // Chỉ Quản trị hệ thống (Super Admin) mới được phân quyền hoặc hủy quyền quản trị (canManage)
  if (me.isSuperAdmin && typeof c.body.canManage === "boolean") {
    updateData.canManage = c.body.canManage;
  }

  await db.update(users).set(updateData).where(eq(users.id, id));
  if (c.body.isActive === false) await db.delete(sessions).where(eq(sessions.userId, id));
  return json({ ok: true });
});

route("DELETE", "/api/users/:id", async (c) => {
  const me = requireSuperAdmin(c);
  const id = intParam(c.params.id);
  if (id === me.id) fail(400, "Không thể xoá chính mình.");
  const [target] = await db.select({ role: users.role, isSuperAdmin: users.isSuperAdmin }).from(users).where(eq(users.id, id));
  if (!target) fail(404, "Không tìm thấy tài khoản.");
  if (target.isSuperAdmin) fail(403, "Không thể xoá tài khoản Quản trị hệ thống.");
  await db.delete(users).where(eq(users.id, id));
  return json({ ok: true });
});

async function parentEasyPassword(parentId: number): Promise<string | null> {
  const kids = await db.select({ fullName: students.fullName, dob: students.dateOfBirth }).from(parentStudents)
    .innerJoin(students, eq(students.id, parentStudents.studentId))
    .where(eq(parentStudents.parentId, parentId)).orderBy(asc(students.id));
  for (const k of kids) { const pw = easyParentPassword(k.fullName, k.dob); if (pw) return pw; }
  return null;
}

route("POST", "/api/users/:id/reset-password", async (c) => {
  const me = requireAdmin(c);
  const id = intParam(c.params.id);
  const [target] = await db.select({ role: users.role, isSuperAdmin: users.isSuperAdmin }).from(users).where(eq(users.id, id));
  if (!target) fail(404, "Không tìm thấy tài khoản.");
  if (target.isSuperAdmin && !me.isSuperAdmin) fail(403, "Chỉ Quản trị hệ thống mới có thể đặt lại mật khẩu của chính mình.");

  const password = (target.role === "parent" ? await parentEasyPassword(id) : null) ?? randomPassword();
  const [row] = await db.update(users).set({
    passwordHash: await hashPassword(password), mustChangePassword: true, failedAttempts: 0, lockedUntil: null,
  }).where(eq(users.id, id)).returning({ username: users.username });
  await db.delete(sessions).where(eq(sessions.userId, id));
  return json({ username: row.username, password });
});

route("GET", "/api/assignments", async (c) => {
  requireAdmin(c);
  return json(await db.select({
    id: teacherAssignments.id, teacherId: teacherAssignments.teacherId, classId: teacherAssignments.classId,
    subjectId: teacherAssignments.subjectId, teacherName: users.fullName, className: classes.name,
    schoolYear: classes.schoolYear, subjectName: subjects.name,
  }).from(teacherAssignments)
    .innerJoin(users, eq(users.id, teacherAssignments.teacherId))
    .innerJoin(classes, eq(classes.id, teacherAssignments.classId))
    .innerJoin(subjects, eq(subjects.id, teacherAssignments.subjectId))
    .orderBy(asc(users.fullName), asc(classes.name), asc(subjects.sortOrder)));
});

route("POST", "/api/assignments", async (c) => {
  requireAdmin(c);
  const teacherId = (await validTeacherId(c.body.teacherId)) ?? fail(400, "Chọn giáo viên.");
  const subjectId = intParam(c.body.subjectId);
  const classIds: number[] = Array.isArray(c.body.classIds) ? c.body.classIds.map(intParam) : [intParam(c.body.classId)];
  if (!classIds.length) fail(400, "Chọn ít nhất một lớp.");
  await db.insert(teacherAssignments).values(classIds.map((classId) => ({ teacherId, classId, subjectId })))
    .onConflictDoNothing();
  return json({ ok: true }, { status: 201 });
});

route("DELETE", "/api/assignments/:id", async (c) => {
  requireAdmin(c);
  await db.delete(teacherAssignments).where(eq(teacherAssignments.id, intParam(c.params.id)));
  return json({ ok: true });
});

// ---------- Hồ sơ học sinh ----------

const studentCols = {
  id: students.id, studentCode: students.studentCode, classId: students.classId, fullName: students.fullName,
  dateOfBirth: students.dateOfBirth, gender: students.gender, address: students.address,
  fatherName: students.fatherName, fatherPhone: students.fatherPhone,
  motherName: students.motherName, motherPhone: students.motherPhone, note: students.note,
};

route("GET", "/api/students", async (c) => {
  const u = requireUser(c);
  const classId = c.url.searchParams.get("classId");

  // Kiểm tra quyền: Quản trị viên xem được tất cả; Giáo viên chủ nhiệm chỉ xem được học sinh lớp mình
  let allowedClassIds: number[] | null = null;
  if (u.role !== "admin" && !u.canManage) {
    if (u.role === "teacher") {
      const myClasses = await db.select({ id: classes.id }).from(classes).where(eq(classes.homeroomTeacherId, u.id));
      if (!myClasses.length) fail(403, "Chỉ quản trị viên hoặc giáo viên chủ nhiệm mới có quyền xem hồ sơ học sinh.");
      allowedClassIds = myClasses.map((cl) => cl.id);
    } else {
      fail(403, "Chỉ quản trị viên hoặc giáo viên mới có quyền xem.");
    }
  }

  const q = db.select({ ...studentCols, className: classes.name, schoolYear: classes.schoolYear })
    .from(students).leftJoin(classes, eq(classes.id, students.classId));

  let rows;
  if (allowedClassIds) {
    if (classId && allowedClassIds.includes(intParam(classId))) {
      rows = await q.where(eq(students.classId, intParam(classId)));
    } else {
      rows = await q.where(inArray(students.classId, allowedClassIds));
    }
  } else {
    rows = classId === "none" ? await q.where(sql`${students.classId} is null`)
      : classId ? await q.where(eq(students.classId, intParam(classId))) : await q;
  }
  return json(sortByVietnameseName(rows));
});

function sortByVietnameseName<T extends { fullName: string }>(rows: T[]): T[] {
  const given = (n: string) => n.trim().split(/\s+/).pop() || "";
  return rows.sort((a, b) => given(a.fullName).localeCompare(given(b.fullName), "vi") || a.fullName.localeCompare(b.fullName, "vi"));
}

type StudentInput = {
  studentCode: string; fullName: string; dateOfBirth: string | null; gender: string | null; address: string | null;
  fatherName: string | null; fatherPhone: string | null; motherName: string | null; motherPhone: string | null; note: string | null;
};
function studentInput(b: any): { data: StudentInput; errors: string[] } {
  const errors: string[] = [];
  const fullName = str(b.fullName, 100);
  if (!fullName) errors.push("thiếu họ tên");
  const phone = (v: unknown, label: string) => {
    if (!str(v)) return null;
    const p = normalizePhone(v);
    if (!p) errors.push(`${label} không hợp lệ (${str(v, 20)})`);
    return p;
  };
  let gender = optStr(b.gender, 10);
  if (gender) {
    const g = gender.toLowerCase();
    gender = g === "nam" || g === "m" ? "Nam" : g === "nữ" || g === "nu" || g === "f" ? "Nữ" : gender;
  }
  let studentCode = str(b.studentCode, 30);
  if (!studentCode && fullName) {
    // Tự sinh mã duy nhất: họ tên slug + ngày sinh + tên lớp + 4 ký tự ngẫu nhiên (tránh ghi đè trùng tên)
    const slug = fullName.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").replace(/[^a-z0-9]/gi, "").toUpperCase();
    const dobPart = str(b.dateOfBirth).replace(/\D/g, "") || "0";
    const classPart = str(b.className || "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 5) || "K";
    const randPart = randomPassword(4).toUpperCase();
    studentCode = `HS-${slug.slice(0, 10)}-${dobPart}-${classPart}-${randPart}`;
  }
  return {
    errors,
    data: {
      studentCode, fullName, dateOfBirth: optStr(b.dateOfBirth, 20), gender, address: optStr(b.address),
      fatherName: optStr(b.fatherName, 100), fatherPhone: phone(b.fatherPhone, "SĐT bố"),
      motherName: optStr(b.motherName, 100), motherPhone: phone(b.motherPhone, "SĐT mẹ"), note: optStr(b.note),
    },
  };
}

type NewAccount = { phone: string; fullName: string; password: string; students: string[]; easy: string | null };
type ParentSyncItem = { studentId: number; studentName: string; childName: string; childDob: string | null; phones: { phone: string; name: string | null }[] };

// Tạo (nếu chưa có) tài khoản phụ huynh theo SĐT và liên kết với học sinh
async function syncParents(list: ParentSyncItem[]) {
  const warnings: string[] = [];
  const allPhones = [...new Set(list.flatMap((s) => s.phones.map((p) => p.phone)))];
  const existing = new Map<string, { id: number; role: string }>();
  for (const part of chunk(allPhones)) {
    for (const u of await db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(inArray(users.username, part)))
      existing.set(u.username, u);
  }
  const toCreate = new Map<string, NewAccount>();
  for (const s of list) for (const p of s.phones) {
    if (existing.has(p.phone)) continue;
    const acc = toCreate.get(p.phone) ?? { phone: p.phone, fullName: p.name || "Phụ huynh", password: "", students: [], easy: easyParentPassword(s.childName, s.childDob) };
    acc.students.push(s.studentName);
    toCreate.set(p.phone, acc);
  }
  const created = [...toCreate.values()];
  for (const part of chunk(created, 100)) {
    const values = await Promise.all(part.map(async (a) => {
      a.password = a.easy ?? randomPassword();
      return { username: a.phone, fullName: a.fullName, role: "parent", passwordHash: await hashPassword(a.password) };
    }));
    const rows = await db.insert(users).values(values).onConflictDoNothing().returning({ id: users.id, username: users.username, role: users.role });
    for (const r of rows) existing.set(r.username, r);
  }
  const links: { parentId: number; studentId: number }[] = [];
  for (const s of list) for (const p of s.phones) {
    const u = existing.get(p.phone);
    if (!u) continue;
    // Nếu trùng SĐT với giáo viên/quản trị viên, vẫn liên kết để giáo viên xem được điểm của con mình
    links.push({ parentId: u.id, studentId: s.studentId });
  }
  for (const part of chunk(links, 500)) await db.insert(parentStudents).values(part).onConflictDoNothing();
  const done = created.filter((a) => existing.has(a.phone));
  const randomOnes = done.filter((a) => !a.easy).length;
  if (randomOnes) warnings.push(`${randomOnes} tài khoản phụ huynh dùng mật khẩu ngẫu nhiên vì học sinh thiếu ngày sinh hoặc ngày sinh không đúng dạng dd/mm/yyyy.`);
  return { created: done.map(({ easy, ...a }) => a), warnings };
}

route("POST", "/api/students", async (c) => {
  requireAdmin(c);
  const { data, errors } = studentInput(c.body);
  if (errors.length) fail(400, "Dữ liệu chưa hợp lệ: " + errors.join("; "));
  const classId = c.body.classId ? intParam(c.body.classId) : null;
  const [row] = await db.insert(students).values({ ...data, classId }).onConflictDoNothing().returning({ id: students.id });
  if (!row) fail(409, "Mã học sinh đã tồn tại.");
  const phones = [
    data.fatherPhone && { phone: data.fatherPhone, name: data.fatherName },
    data.motherPhone && { phone: data.motherPhone, name: data.motherName },
  ].filter(Boolean) as { phone: string; name: string | null }[];
  const result = await syncParents([{ studentId: row.id, studentName: data.fullName, childName: data.fullName, childDob: data.dateOfBirth, phones }]);
  return json({ id: row.id, ...result }, { status: 201 });
});

route("PUT", "/api/students/:id", async (c) => {
  requireAdmin(c);
  const id = intParam(c.params.id);
  const { data, errors } = studentInput(c.body);
  if (errors.length) fail(400, "Dữ liệu chưa hợp lệ: " + errors.join("; "));
  const classId = c.body.classId ? intParam(c.body.classId) : null;
  try {
    await db.update(students).set({ ...data, classId }).where(eq(students.id, id));
  } catch { fail(409, "Mã học sinh bị trùng."); }
  const phones = [
    data.fatherPhone && { phone: data.fatherPhone, name: data.fatherName },
    data.motherPhone && { phone: data.motherPhone, name: data.motherName },
  ].filter(Boolean) as { phone: string; name: string | null }[];
  const keep = phones.map((p) => p.phone);
  const links = await db.select({ parentId: parentStudents.parentId, username: users.username })
    .from(parentStudents).innerJoin(users, eq(users.id, parentStudents.parentId)).where(eq(parentStudents.studentId, id));
  const stale = links.filter((l) => !keep.includes(l.username)).map((l) => l.parentId);
  if (stale.length) await db.delete(parentStudents).where(and(eq(parentStudents.studentId, id), inArray(parentStudents.parentId, stale)));
  const result = await syncParents([{ studentId: id, studentName: data.fullName, childName: data.fullName, childDob: data.dateOfBirth, phones }]);
  return json({ ok: true, ...result });
});

route("DELETE", "/api/students/:id", async (c) => {
  requireAdmin(c);
  await db.delete(students).where(eq(students.id, intParam(c.params.id)));
  return json({ ok: true });
});

route("POST", "/api/students/import", async (c) => {
  requireAdmin(c);
  const schoolYear = str(c.body.schoolYear, 9);
  if (!YEAR_RE.test(schoolYear)) fail(400, "Năm học có dạng 2025-2026.");
  const rows: any[] = Array.isArray(c.body.rows) ? c.body.rows : [];
  if (!rows.length) fail(400, "File không có dòng dữ liệu nào.");
  if (rows.length > 3000) fail(400, "Mỗi lần chỉ nhập tối đa 3000 học sinh.");

  const errors: string[] = [];
  const valid: (StudentInput & { className: string })[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const line = Number(r._row) || i + 2;
    const { data, errors: errs } = studentInput(r);
    const className = str(r.className, 30).replace(/^lớp\s+/i, "").toUpperCase();
    if (!className) errs.push("thiếu lớp");
    if (data.studentCode && seen.has(data.studentCode)) errs.push(`mã học sinh ${data.studentCode} bị lặp trong file`);
    if (errs.length) { errors.push(`Dòng ${line}: ${errs.join("; ")}`); return; }
    seen.add(data.studentCode);
    valid.push({ ...data, className });
  });

  const classNames = [...new Set(valid.map((v) => v.className))];
  if (classNames.length) await db.insert(classes).values(classNames.map((name) => ({ name, schoolYear }))).onConflictDoNothing();
  const classMap = new Map<string, number>();
  if (classNames.length) for (const cl of await db.select({ id: classes.id, name: classes.name }).from(classes)
    .where(and(eq(classes.schoolYear, schoolYear), inArray(classes.name, classNames)))) classMap.set(cl.name, cl.id);

  const idByCode = new Map<string, number>();
  for (const part of chunk(valid, 200)) {
    const res = await db.insert(students).values(part.map(({ className, ...s }) => ({ ...s, classId: classMap.get(className)! })))
      .onConflictDoUpdate({
        target: students.studentCode,
        set: {
          classId: sql`excluded.class_id`, fullName: sql`excluded.full_name`, dateOfBirth: sql`excluded.date_of_birth`,
          gender: sql`excluded.gender`, address: sql`excluded.address`, fatherName: sql`excluded.father_name`,
          fatherPhone: sql`excluded.father_phone`, motherName: sql`excluded.mother_name`,
          motherPhone: sql`excluded.mother_phone`, note: sql`excluded.note`,
        },
      }).returning({ id: students.id, code: students.studentCode });
    for (const r of res) idByCode.set(r.code, r.id);
  }

  const parentList = valid.map((v) => ({
    studentId: idByCode.get(v.studentCode)!, studentName: `${v.fullName} (${v.className})`,
    childName: v.fullName, childDob: v.dateOfBirth,
    phones: [
      v.fatherPhone && { phone: v.fatherPhone, name: v.fatherName },
      v.motherPhone && { phone: v.motherPhone, name: v.motherName },
    ].filter(Boolean) as { phone: string; name: string | null }[],
  }));
  const { created, warnings } = await syncParents(parentList);
  const noPhone = valid.filter((v) => !v.fatherPhone && !v.motherPhone).length;
  if (noPhone) warnings.push(`${noPhone} học sinh không có SĐT bố/mẹ nên chưa có tài khoản phụ huynh.`);

  return json({ imported: valid.length, classesTouched: classNames.length, errors, warnings, newAccounts: created });
});

route("GET", "/api/parents", async (c) => {
  requireAdmin(c);
  const rows = await db.select({
    id: users.id, username: users.username, fullName: users.fullName, isActive: users.isActive,
    mustChangePassword: users.mustChangePassword,
    children: sql<string>`coalesce(string_agg(${students.fullName} || coalesce(' (' || ${classes.name} || ')', ''), ', ' order by ${students.fullName}), '')`,
  }).from(users)
    .leftJoin(parentStudents, eq(parentStudents.parentId, users.id))
    .leftJoin(students, eq(students.id, parentStudents.studentId))
    .leftJoin(classes, eq(classes.id, students.classId))
    .where(eq(users.role, "parent")).groupBy(users.id).orderBy(asc(users.username));
  return json(rows);
});

route("POST", "/api/parents/easy-passwords", async (c) => {
  requireAdmin(c);
  const list = await db.select({ id: users.id, username: users.username, fullName: users.fullName }).from(users)
    .where(and(eq(users.role, "parent"), eq(users.mustChangePassword, true)));
  const out: { phone: string; fullName: string; password: string; students: string[] }[] = [];
  let skipped = 0;
  for (const p of list) {
    const pw = await parentEasyPassword(p.id);
    if (!pw) { skipped++; continue; }
    await db.update(users).set({ passwordHash: await hashPassword(pw), failedAttempts: 0, lockedUntil: null }).where(eq(users.id, p.id));
    const kids = await db.select({ n: students.fullName }).from(parentStudents).innerJoin(students, eq(students.id, parentStudents.studentId))
      .where(eq(parentStudents.parentId, p.id));
    out.push({ phone: p.username, fullName: p.fullName, password: pw, students: kids.map((k) => k.n) });
  }
  return json({ updated: out, skipped });
});

route("PUT", "/api/parents/:id", async (c) => {
  requireAdmin(c);
  const id = intParam(c.params.id);
  await db.update(users).set({ isActive: c.body.isActive !== false }).where(and(eq(users.id, id), eq(users.role, "parent")));
  if (c.body.isActive === false) await db.delete(sessions).where(eq(sessions.userId, id));
  return json({ ok: true });
});

// ---------- Sổ điểm ----------

route("GET", "/api/gradebook/options", async (c) => {
  const u = requireUser(c);
  if (u.role === "parent") fail(403, "Không có quyền.");
  const allSubjects = await db.select().from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.name));

  // Quản trị viên (admin hoặc giáo viên canManage) xem được tất cả
  if (u.role === "admin" || u.canManage) {
    const cls = await db.select({ id: classes.id, name: classes.name, schoolYear: classes.schoolYear, hr: classes.homeroomTeacherId }).from(classes)
      .orderBy(sql`${classes.schoolYear} desc`, asc(classes.name));
    return json(cls.map(({ hr, ...cl }) => ({ ...cl, isHomeroom: hr === u.id, subjects: allSubjects.map((s) => ({ ...s, canEdit: true })) })));
  }

  // Giáo viên bình thường: xem các lớp được phân công và lớp chủ nhiệm
  const assigned = await db.select({ classId: teacherAssignments.classId, subjectId: teacherAssignments.subjectId })
    .from(teacherAssignments).where(eq(teacherAssignments.teacherId, u.id));
  const homeroom = await db.select({ id: classes.id }).from(classes).where(eq(classes.homeroomTeacherId, u.id));
  const classIds = [...new Set([...assigned.map((a) => a.classId), ...homeroom.map((h) => h.id)])];
  if (!classIds.length) return json([]);
  const cls = await db.select({ id: classes.id, name: classes.name, schoolYear: classes.schoolYear }).from(classes)
    .where(inArray(classes.id, classIds)).orderBy(sql`${classes.schoolYear} desc`, asc(classes.name));
  const homeSet = new Set(homeroom.map((h) => h.id));
  return json(cls.map((cl) => {
    const mine = new Set(assigned.filter((a) => a.classId === cl.id).map((a) => a.subjectId));
    const list = allSubjects.filter((s) => homeSet.has(cl.id) || mine.has(s.id)).map((s) => ({ ...s, canEdit: mine.has(s.id) }));
    return { ...cl, isHomeroom: homeSet.has(cl.id), subjects: list };
  }));
});

async function gradeAccess(u: SessionUser, classId: number, subjectId: number) {
  const [cl] = await db.select().from(classes).where(eq(classes.id, classId));
  if (!cl) fail(404, "Không tìm thấy lớp.");
  if (u.role === "admin" || u.canManage) return { cl, canEdit: true };
  if (u.role !== "teacher") fail(403, "Không có quyền.");
  const [a] = await db.select({ id: teacherAssignments.id }).from(teacherAssignments).where(and(
    eq(teacherAssignments.teacherId, u.id), eq(teacherAssignments.classId, classId), eq(teacherAssignments.subjectId, subjectId)));
  if (a) return { cl, canEdit: true };
  if (cl.homeroomTeacherId === u.id) return { cl, canEdit: false };
  return fail(403, "Bạn không được phân công lớp/môn này.");
}
const semesterParam = (v: unknown) => (Number(v) === 2 ? 2 : Number(v) === 1 ? 1 : fail(400, "Học kỳ không hợp lệ."));

route("GET", "/api/grades", async (c) => {
  const u = requireUser(c);
  const classId = intParam(c.url.searchParams.get("classId"));
  const subjectId = intParam(c.url.searchParams.get("subjectId"));
  const semester = semesterParam(c.url.searchParams.get("semester"));
  const { cl, canEdit } = await gradeAccess(u, classId, subjectId);

  const [subj] = await db.select().from(subjects).where(eq(subjects.id, subjectId));
  if (!subj) fail(404, "Không tìm thấy môn học.");

  const list = sortByVietnameseName(await db.select({ id: students.id, studentCode: students.studentCode, fullName: students.fullName, dateOfBirth: students.dateOfBirth })
    .from(students).where(eq(students.classId, classId)));
  const ids = list.map((s) => s.id);
  const g = ids.length ? await db.select({ studentId: grades.studentId, kind: grades.kind, slot: grades.slot, score: grades.score, scoreText: grades.scoreText })
    .from(grades).where(and(inArray(grades.studentId, ids), eq(grades.subjectId, subjectId),
      eq(grades.schoolYear, cl.schoolYear), eq(grades.semester, semester))) : [];

  return json({
    class: { id: cl.id, name: cl.name, schoolYear: cl.schoolYear },
    subject: { id: subj.id, name: subj.name, evaluationType: subj.evaluationType },
    canEdit,
    students: list,
    grades: g.map((x) => ({ ...x, score: Number(x.score), scoreText: x.scoreText })),
  });
});

route("PUT", "/api/grades", async (c) => {
  const u = requireUser(c);
  const classId = intParam(c.body.classId);
  const subjectId = intParam(c.body.subjectId);
  const semester = semesterParam(c.body.semester);
  const { cl, canEdit } = await gradeAccess(u, classId, subjectId);
  if (!canEdit) fail(403, "Bạn chỉ có quyền xem điểm môn này.");

  const [subj] = await db.select().from(subjects).where(eq(subjects.id, subjectId));
  if (!subj) fail(404, "Không tìm thấy môn học.");
  const isComment = subj.evaluationType === "comment";

  const entries: any[] = Array.isArray(c.body.entries) ? c.body.entries : [];
  if (entries.length > 10000) fail(400, "Quá nhiều dữ liệu.");
  const inClass = new Set((await db.select({ id: students.id }).from(students).where(eq(students.classId, classId))).map((s) => s.id));
  const upserts: (typeof grades.$inferInsert)[] = [];
  const deletes: { studentId: number; kind: string; slot: number }[] = [];

  for (const e of entries) {
    const studentId = Number(e.studentId), slot = Number(e.slot) || 1, kind = String(e.kind);
    if (!inClass.has(studentId)) fail(400, "Học sinh không thuộc lớp này.");
    if (!["tx", "gk", "ck"].includes(kind) || !Number.isInteger(slot) || slot < 1 || slot > 10 || (kind !== "tx" && slot !== 1))
      fail(400, "Cột điểm không hợp lệ.");

    if (e.score === null || e.score === "" || e.score === undefined) {
      deletes.push({ studentId, kind, slot });
      continue;
    }

    if (isComment) {
      // Môn đánh giá bằng nhận xét: Đ (1) hoặc CĐ (0)
      const parsed = parseCommentGrade(e.score);
      if (!parsed) { deletes.push({ studentId, kind, slot }); continue; }
      upserts.push({
        studentId, subjectId, schoolYear: cl.schoolYear, semester, kind, slot,
        score: parsed.score, scoreText: parsed.scoreText, updatedBy: u.id, updatedAt: new Date(),
      });
    } else {
      // Môn đánh giá bằng điểm số: 0 - 10
      const score = Number(e.score);
      if (!Number.isFinite(score) || score < 0 || score > 10) fail(400, `Điểm ${e.score} không hợp lệ (0–10).`);
      upserts.push({
        studentId, subjectId, schoolYear: cl.schoolYear, semester, kind, slot,
        score: (Math.round(score * 100) / 100).toFixed(2), scoreText: null, updatedBy: u.id, updatedAt: new Date(),
      });
    }
  }

  for (const part of chunk(upserts, 300)) {
    await db.insert(grades).values(part).onConflictDoUpdate({
      target: [grades.studentId, grades.subjectId, grades.schoolYear, grades.semester, grades.kind, grades.slot],
      set: {
        score: sql`excluded.score`,
        scoreText: sql`excluded.score_text`,
        updatedBy: sql`excluded.updated_by`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  }

  // Tối ưu xoá điểm: gộp theo lô thay vì gọi từng lệnh DELETE đơn lẻ
  if (deletes.length) {
    for (const part of chunk(deletes, 60)) {
      const conds = part.map((d) => sql`(${grades.studentId} = ${d.studentId} and ${grades.kind} = ${d.kind} and ${grades.slot} = ${d.slot})`);
      await db.delete(grades).where(and(
        eq(grades.subjectId, subjectId),
        eq(grades.schoolYear, cl.schoolYear),
        eq(grades.semester, semester),
        sql.join(conds, sql` or `),
      ));
    }
  }

  return json({ ok: true, saved: upserts.length, removed: deletes.length });
});

// ---------- Phụ huynh & Học sinh xem điểm ----------

route("GET", "/api/my-children", async (c) => {
  const u = requireUser(c);
  // Cho phép phụ huynh, hoặc giáo viên / quản trị viên có con học tại trường
  const kids = await db.select({
    id: students.id, fullName: students.fullName, studentCode: students.studentCode,
    dateOfBirth: students.dateOfBirth, className: classes.name, schoolYear: classes.schoolYear,
  }).from(parentStudents)
    .innerJoin(students, eq(students.id, parentStudents.studentId))
    .leftJoin(classes, eq(classes.id, students.classId))
    .where(eq(parentStudents.parentId, u.id));
  return json(kids);
});

route("GET", "/api/my-children/:id/grades", async (c) => {
  const u = requireUser(c);
  const sid = intParam(c.params.id);
  const [link] = await db.select().from(parentStudents).where(and(eq(parentStudents.parentId, u.id), eq(parentStudents.studentId, sid)));
  if (!link) fail(403, "Không có quyền xem học sinh này.");

  const rows = await db.select({
    subjectId: grades.subjectId, schoolYear: grades.schoolYear, semester: grades.semester,
    kind: grades.kind, slot: grades.slot, score: grades.score, scoreText: grades.scoreText,
  }).from(grades).where(eq(grades.studentId, sid));

  const subj = await db.select().from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.name));
  return json({
    subjects: subj,
    grades: rows.map((r) => ({ ...r, score: Number(r.score), scoreText: r.scoreText })),
  });
});

// ---------- Router ----------

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
  if (!match) return json({ error: "Không tìm thấy." }, { status: 404 });
  try {
    const ct = req.headers.get("content-type") || "";
    if (req.method !== "GET" && ct && !ct.includes("application/json")) fail(415, "Yêu cầu không hợp lệ.");
    const m = path.match(match.pattern)!;
    const params: Record<string, string> = {};
    match.keys.forEach((k, i) => (params[k] = m[i + 1]));
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
    const user = await getSessionUser(req);
    return await match.handler({ req, user, params, body: body ?? {}, url });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
    console.error(err);
    return json({ error: "Lỗi máy chủ. Vui lòng thử lại." }, { status: 500 });
  }
};

export const config: Config = { path: "/api/*" };
