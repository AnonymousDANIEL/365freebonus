import { createHmac, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const SESSION_COOKIE = "directory_admin";
export const SESSION_MAX_AGE = 8 * 60 * 60;
export type AuthConfig = { username: string; passwordHash: string; secret: string };
export type SessionPayload = { sub: string; iat: number; exp: number; jti: string };

export function authConfig(): AuthConfig | null {
  const username = process.env.ADMIN_USERNAME || "admin";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH || "";
  const secret = process.env.SESSION_SECRET || "";
  if (!/^[^\s]{1,80}$/.test(username) || !/^scrypt\$[a-f0-9]{32,128}\$[a-f0-9]{128}$/i.test(passwordHash) || secret.length < 32) return null;
  const salt = passwordHash.split("$")[1];
  if (salt.length % 2 !== 0) return null;
  return { username, passwordHash, secret };
}

export async function verifyCredentials(username: string, password: string, config: AuthConfig): Promise<boolean> {
  const [, salt, expectedHex] = config.passwordHash.split("$");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scrypt(password, Buffer.from(salt, "hex"), 64) as Buffer;
  const usernameMatches = timingSafeEqual(createHash("sha256").update(username).digest(), createHash("sha256").update(config.username).digest());
  return timingSafeEqual(actual, expected) && usernameMatches;
}

export function sessionIdHash(id: string): string { return createHash("sha256").update(id).digest("hex"); }

export function issueSession(config: AuthConfig, now = Math.floor(Date.now() / 1000)) {
  const payload: SessionPayload = { sub: config.username, iat: now, exp: now + SESSION_MAX_AGE, jti: randomBytes(32).toString("base64url") };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", config.secret).update(encoded).digest("base64url");
  return { token: `${encoded}.${signature}`, payload };
}

export function verifySession(token: string | undefined, config: AuthConfig, now = Math.floor(Date.now() / 1000)): SessionPayload | null {
  if (!token || token.length > 1500) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  const expected = createHmac("sha256", config.secret).update(parts[0]).digest();
  const provided = Buffer.from(parts[1], "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as SessionPayload;
    if (payload.sub !== config.username || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now + 30 || payload.exp <= now || payload.exp - payload.iat !== SESSION_MAX_AGE || !/^[A-Za-z0-9_-]{43}$/.test(payload.jti)) return null;
    return payload;
  } catch { return null; }
}

export function getAdminPath(): string {
  const path = process.env.ADMIN_PATH;
  if (path && /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path) && path !== "/login" && path !== "/api") return path;
  return "/admin";
}

export function safeReturnPath(value: unknown, fallback = getAdminPath()): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || url.pathname.startsWith("//") || url.pathname === "/login" || url.pathname.startsWith("/api/")) return fallback;
    if (url.pathname === "/admin" || url.pathname === "/admin/") url.pathname = getAdminPath();
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

export function trustedOrigin(request: Request): string | null {
  const configured = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
  if (configured) {
    try {
      const url = new URL(configured);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
    } catch { return null; }
  }
  // In production the expected origin must come from trusted deployment config,
  // never a visitor-controlled Host or X-Forwarded-Host header.
  return process.env.NODE_ENV !== "production" ? new URL(request.url).origin : null;
}

export function hasValidOrigin(request: Request): boolean {
  const expected = trustedOrigin(request);
  return Boolean(expected && request.headers.get("origin") === expected && request.headers.get("sec-fetch-site") !== "cross-site");
}
