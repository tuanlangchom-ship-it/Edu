import {
  pgTable, serial, text, integer, boolean, timestamp, numeric, primaryKey, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// Tài khoản đăng nhập: quản trị hệ thống (admin), giáo viên (teacher), phụ huynh (parent).
// Phụ huynh dùng số điện thoại làm tên đăng nhập.
// canManage: cho phép giáo viên có quyền quản trị (thêm lớp, thêm học sinh, phân công...)
// isSuperAdmin: quản trị viên hệ thống cao nhất
export const users = pgTable("users", {
  id: serial().primaryKey(),
  username: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull().default(""),
  role: text().notNull(), // 'admin' | 'teacher' | 'parent'
  canManage: boolean("can_manage").notNull().default(false),
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const classes = pgTable("classes", {
  id: serial().primaryKey(),
  name: text().notNull(),
  schoolYear: text("school_year").notNull(),
  homeroomTeacherId: integer("homeroom_teacher_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("classes_name_year_uq").on(t.name, t.schoolYear)]);

// evaluationType: 'score' (điểm số 0-10) hoặc 'comment' (nhận xét Đạt/Chưa đạt theo Thông tư 22)
export const subjects = pgTable("subjects", {
  id: serial().primaryKey(),
  name: text().notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  evaluationType: text("evaluation_type").notNull().default("score"),
});

export const students = pgTable("students", {
  id: serial().primaryKey(),
  studentCode: text("student_code").notNull().unique(),
  classId: integer("class_id").references(() => classes.id, { onDelete: "set null" }),
  fullName: text("full_name").notNull(),
  dateOfBirth: text("date_of_birth"),
  gender: text(),
  address: text(),
  fatherName: text("father_name"),
  fatherPhone: text("father_phone"),
  motherName: text("mother_name"),
  motherPhone: text("mother_phone"),
  note: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("students_class_idx").on(t.classId)]);

export const parentStudents = pgTable("parent_students", {
  parentId: integer("parent_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  studentId: integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.parentId, t.studentId] })]);

export const teacherAssignments = pgTable("teacher_assignments", {
  id: serial().primaryKey(),
  teacherId: integer("teacher_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  classId: integer("class_id").notNull().references(() => classes.id, { onDelete: "cascade" }),
  subjectId: integer("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("assign_uq").on(t.teacherId, t.classId, t.subjectId)]);

// Điểm theo Thông tư 22: kind = 'tx' (thường xuyên, slot 1..n), 'gk' (giữa kỳ), 'ck' (cuối kỳ).
// Với môn nhận xét: score = 1.00 (Đạt), 0.00 (Chưa đạt), scoreText = 'Đ' | 'CĐ'
export const grades = pgTable("grades", {
  id: serial().primaryKey(),
  studentId: integer("student_id").notNull().references(() => students.id, { onDelete: "cascade" }),
  subjectId: integer("subject_id").notNull().references(() => subjects.id, { onDelete: "cascade" }),
  schoolYear: text("school_year").notNull(),
  semester: integer().notNull(), // 1 | 2
  kind: text().notNull(),
  slot: integer().notNull().default(1),
  score: numeric({ precision: 4, scale: 2 }).notNull().default("0.00"),
  scoreText: text("score_text"),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("grades_uq").on(t.studentId, t.subjectId, t.schoolYear, t.semester, t.kind, t.slot),
  index("grades_student_idx").on(t.studentId),
]);
