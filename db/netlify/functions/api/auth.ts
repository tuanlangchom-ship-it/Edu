import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomInt } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { sessions, users } from "../../../db/schema.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SESSION_COOKIE = "et_session";
const SESSION_DAYS = 14;

export type SessionUser = {
  id: number; username: string; fullName: string; role: "admin" | "teacher" | "parent"; mustChangePassword: boolean;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Mật khẩu ngẫu nhiên dễ đọc (bỏ các ký tự dễ nhầm như 0/O, 1/l/I).
export function randomPassword(length = 8): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)];
  return out;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readToken(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v.join("=") || null;
  }
  return null;
}

export async function destroySession(req: Request) {
  const token = readToken(req);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const token = readToken(req);
  if (!token) return null;
  const rows = await db
    .select({
      id: users.id, username: users.username, fullName: users.fullName, role: users.role,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date()), eq(users.isActive, true)))
    .limit(1);
  return (rows[0] as SessionUser) ?? null;
}

// Chuẩn hoá số điện thoại Việt Nam: bỏ ký tự không phải số, +84 → 0, bù số 0 bị Excel làm mất.
export function normalizePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/\D/g, "");
  if (!s) return null;
  if (s.startsWith("84") && s.length === 11) s = "0" + s.slice(2);
  if (s.length === 9) s = "0" + s;
  if (!/^0\d{9}$/.test(s)) return null;
  return s;
}

// Mật khẩu dễ nhớ cho phụ huynh: tên con (không dấu, viết thường) + ngày sinh dạng ddmm.
// VD: "Hà Văn Bằng", "21/03/2015" → "bang2103". Trả về null nếu thiếu tên hoặc ngày sinh.
export function easyParentPassword(fullName: string | null | undefined, dob: string | null | undefined): string | null {
  const given = String(fullName ?? "").trim().split(/\s+/).pop() || "";
  const name = given.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z]/g, "");
  const s = String(dob ?? "").trim();
  let d: number | undefined, m: number | undefined;
  let mt: RegExpMatchArray | null;
  if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) { m = +mt[2]; d = +mt[3]; }
  else if ((mt = s.match(/^(\d{1,2})[-/.\s](\d{1,2})(?:[-/.\s]\d{2,4})?$/))) { d = +mt[1]; m = +mt[2]; }
  else if ((mt = s.match(/^(\d{2})(\d{2})\d{4}$/))) { d = +mt[1]; m = +mt[2]; }
  if (!name || !d || !m || d > 31 || m > 12) return null;
  const pw = `${name}${String(d).padStart(2, "0")}${String(m).padStart(2, "0")}`;
  return pw.length >= 6 ? pw : null;
}
