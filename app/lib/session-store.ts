import { isIP } from "node:net";
import { getSqlite } from "./sqlite";
import { sessionIdHash, type SessionPayload } from "./auth-core";

export function saveSession(payload: SessionPayload) {
  const db = getSqlite();
  db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(Math.floor(Date.now() / 1000));
  // A bounded number of active sessions is enough for one administrator.
  db.prepare("DELETE FROM admin_sessions WHERE id_hash IN (SELECT id_hash FROM admin_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 31)").run();
  db.prepare("INSERT INTO admin_sessions(id_hash, username, expires_at) VALUES (?, ?, ?)").run(sessionIdHash(payload.jti), payload.sub, payload.exp);
}

export function sessionIsActive(payload: SessionPayload): boolean {
  const row = getSqlite().prepare("SELECT username, expires_at FROM admin_sessions WHERE id_hash = ?").get(sessionIdHash(payload.jti)) as { username: string; expires_at: number } | undefined;
  return Boolean(row && row.username === payload.sub && row.expires_at === payload.exp && row.expires_at > Math.floor(Date.now() / 1000));
}

export function revokeSession(payload: SessionPayload) {
  getSqlite().prepare("DELETE FROM admin_sessions WHERE id_hash=?").run(sessionIdHash(payload.jti));
}

export function clientIpKey(request: Request): string {
  // Railway's edge appends the connecting address. Read the last valid address,
  // rather than trusting a visitor's prepended X-Forwarded-For value.
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",").map(value => value.trim()).filter(value => isIP(value));
  return sessionIdHash(forwarded.at(-1) || "unknown-client");
}

export function consumeLoginAttempt(ipHash: string, now = Date.now()): { allowed: boolean; retryAfter: number } {
  const db = getSqlite();
  const windowMs = 15 * 60 * 1000;
  db.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").run(now);
  const current = db.prepare("SELECT attempts, expires_at FROM login_attempts WHERE ip_hash=?").get(ipHash) as { attempts: number; expires_at: number } | undefined;
  if (!current) {
    const count = db.prepare("SELECT COUNT(*) AS count FROM login_attempts").get() as { count: number };
    if (count.count >= 2048) return { allowed: false, retryAfter: 60 };
    db.prepare("INSERT INTO login_attempts (ip_hash, attempts, expires_at) VALUES (?, 1, ?)").run(ipHash, now + windowMs);
    return { allowed: true, retryAfter: 0 };
  }
  if (current.attempts >= 8) return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.expires_at - now) / 1000)) };
  db.prepare("UPDATE login_attempts SET attempts=attempts+1 WHERE ip_hash=?").run(ipHash);
  return { allowed: true, retryAfter: 0 };
}

export function clearLoginAttempts(ipHash: string) { getSqlite().prepare("DELETE FROM login_attempts WHERE ip_hash=?").run(ipHash); }
