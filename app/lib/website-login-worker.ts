import { randomUUID } from "node:crypto";
import { getSqlite } from "./sqlite";
import { loginWebsite, WebsiteLoginError } from "./website-login-client";
import { readWebsitePassword, readWebsiteSession, encryptWebsiteSession, WebsiteSettingsError, type WebsiteRow } from "./website-logins";

const globalWorker = globalThis as typeof globalThis & { __websiteLoginWorker?: { timer: ReturnType<typeof setInterval>; busy: boolean } };

// One leased attempt at a time; failures pause automation until reviewed.
export async function processWebsiteLogins(limit = 3, execute = loginWebsite) {
  getSqlite().prepare("UPDATE website_logins SET status='error',message='上次登录任务中断，自动登录已暂停。请检查后重新开启。',enabled=0,requested=0,lease_id='',lease_until=0,session_ciphertext='' WHERE status='running' AND lease_until<=?").run(Date.now());
  for (let i = 0; i < limit; i++) {
    const db = getSqlite(), now = Date.now();
    const row = db.prepare("SELECT * FROM website_logins WHERE (enabled=1 OR requested=1) AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,id LIMIT 1").get(now, now) as WebsiteRow | undefined;
    if (!row) return;
    const lease = randomUUID();
    const claimed = db.prepare("UPDATE website_logins SET status='running',message='正在登录并验证',last_attempt_at=?,requested=0,lease_id=?,lease_until=?,next_attempt_at=? WHERE id=? AND revision=? AND lease_until<=? AND (enabled=1 OR requested=1) AND next_attempt_at<=?")
      .run(now, lease, now + 120_000, now + row.interval_minutes * 60_000, row.id, row.revision, now, now);
    if (!claimed.changes) continue;
    let status = "success", message = "已验证登录成功";
    let sessionCiphertext = "";
    try {
      const result = await execute({ loginUrl: row.login_url, verifyUrl: row.verify_url, successText: row.success_text, username: row.username,
        password: readWebsitePassword(row), usernameField: row.username_field, passwordField: row.password_field, existingSession: readWebsiteSession(row) });
      sessionCiphertext = encryptWebsiteSession(row, result.session);
    } catch (error) {
      status = "error";
      message = error instanceof WebsiteLoginError || error instanceof WebsiteSettingsError ? error.message : "连接或登录失败，请检查网站配置后重试。";
      message += " 自动登录已暂停，请检查后重新开启。";
    }
    db.prepare("UPDATE website_logins SET status=?,message=?,last_success_at=CASE WHEN ?='success' THEN ? ELSE last_success_at END,enabled=CASE WHEN ?='error' THEN 0 ELSE enabled END,session_ciphertext=?,lease_id='',lease_until=0 WHERE id=? AND revision=? AND lease_id=?")
      .run(status, message, status, Date.now(), status, sessionCiphertext, row.id, row.revision, lease);
  }
}
export function startWebsiteLoginWorker() {
  if (process.env.NEXT_PHASE === "phase-production-build" || globalWorker.__websiteLoginWorker) return;
  const worker = { timer: undefined as unknown as ReturnType<typeof setInterval>, busy: false };
  const tick = async () => {
    if (worker.busy) return;
    worker.busy = true;
    try { await processWebsiteLogins(); }
    catch { console.error("Website login worker could not read its task queue."); }
    finally { worker.busy = false; }
  };
  worker.timer = setInterval(tick, 10_000);
  worker.timer.unref?.();
  globalWorker.__websiteLoginWorker = worker;
  void tick();
}
