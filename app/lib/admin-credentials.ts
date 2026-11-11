import { createHmac, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { authConfig, verifyCredentials, type AuthConfig, type SessionPayload } from "./auth-core";
import { sessionIsActive } from "./session-store";
import { getSqlite } from "./sqlite";

const scrypt = promisify(scryptCallback);

// Keep the deployment secret unchanged: it also encrypts saved Telegram tokens.
// A changed password gets a new session signing key, including for any login
// that was still verifying the old password while the change committed.
export function getAdminAuthConfig(): AuthConfig | null {
  const base = authConfig();
  if (!base) return null;
  const stored = getSqlite().prepare("SELECT password_hash FROM admin_credentials WHERE id='primary'").get() as { password_hash: string } | undefined;
  if (!stored) return base;
  if (!/^scrypt\$[a-f0-9]{64}\$[a-f0-9]{128}$/.test(stored.password_hash)) throw new Error("Invalid stored administrator credential");
  return {
    ...base,
    passwordHash: stored.password_hash,
    secret: createHmac("sha256", base.secret).update(`admin-session:${stored.password_hash}`).digest("hex"),
  };
}

export class PasswordChangeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function changeAdminPassword(input: unknown, session: SessionPayload, expected: AuthConfig) {
  if (!input || typeof input !== "object") throw new PasswordChangeError(400, "请填写当前密码、新密码和确认密码。");
  const { currentPassword, newPassword, confirmPassword } = input as Record<string, unknown>;
  if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 1024) throw new PasswordChangeError(400, "请输入当前密码。");
  if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128 || !newPassword.trim()) throw new PasswordChangeError(400, "新密码需要 12–128 个字符。");
  if (newPassword !== confirmPassword) throw new PasswordChangeError(400, "两次输入的新密码不一致。");
  if (newPassword === currentPassword) throw new PasswordChangeError(400, "新密码不能与当前密码相同。");
  if (!await verifyCredentials(session.sub, currentPassword, expected)) throw new PasswordChangeError(400, "当前密码不正确。");
  const salt = randomBytes(32);
  const key = await scrypt(newPassword, salt, 64) as Buffer;
  const hash = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
  const db = getSqlite();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getAdminAuthConfig();
    if (!current || current.passwordHash !== expected.passwordHash || current.secret !== expected.secret || current.username !== session.sub || !sessionIsActive(session)) {
      throw new PasswordChangeError(401, "登入已失效，请重新登入后再修改密码。");
    }
    db.prepare("INSERT INTO admin_credentials(id, password_hash, updated_at) VALUES ('primary', ?, ?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, updated_at=excluded.updated_at").run(hash, Date.now());
    db.exec("DELETE FROM notes_vault_unlocks");
    db.exec("DELETE FROM admin_sessions");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
