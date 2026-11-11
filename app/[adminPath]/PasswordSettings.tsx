"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, KeyRound, LoaderCircle } from "lucide-react";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Feedback = { message: string; error?: boolean; sessionExpired?: boolean };

export default function PasswordSettings({ request, signInPath }: { request: AdminRequest; signInPath: string }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [redirect, setRedirect] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    if (!redirect) return;
    const timer = window.setTimeout(() => window.location.assign(redirect), 1200);
    return () => window.clearTimeout(timer);
  }, [redirect]);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || redirect) return;
    setFeedback(null);
    if (newPassword.length < 12 || newPassword.length > 128) {
      setFeedback({ message: "新密码请输入 12 至 128 个字符。", error: true });
      return;
    }
    if (newPassword !== confirmPassword) {
      setFeedback({ message: "两次输入的新密码不一致，请重新确认。", error: true });
      return;
    }
    if (newPassword === currentPassword) {
      setFeedback({ message: "新密码需要与当前密码不同。", error: true });
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const result = await request<{ ok: boolean; redirect: string }>("/api/admin/password", "POST", { currentPassword, newPassword, confirmPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFeedback({ message: "密码已更改，所有已登录设备已退出。请使用新密码重新登入。" });
      setRedirect(typeof result.redirect === "string" && result.redirect.startsWith("/") && !result.redirect.startsWith("//") ? result.redirect : signInPath);
    } catch (error) {
      const sessionExpired = error instanceof Error && "status" in error && error.status === 401;
      setFeedback({ message: error instanceof Error ? error.message : "暂时无法更改密码，请稍后重试。", error: true, sessionExpired });
      setCurrentPassword("");
      if (sessionExpired) {
        setNewPassword("");
        setConfirmPassword("");
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <form className="cms-settings-form" onSubmit={changePassword}>
    {feedback && <div className={`cms-alert ${feedback.error ? "cms-error" : "cms-success"}`} role={feedback.error ? "alert" : "status"}>
      {!feedback.error && <Check size={18} />}
      <span>{feedback.message}</span>
      {(feedback.sessionExpired || redirect) && <a className="cms-reauth" href={redirect || signInPath} target="_top">重新登入 ↗</a>}
    </div>}
    <fieldset disabled={busy || Boolean(redirect) || feedback?.sessionExpired}>
      <section className="cms-settings-panel">
        <div><h2>更改后台密码</h2><p>先验证当前密码，再设置新密码。保存后，所有设备都需要使用新密码重新登入。</p></div>
        <div className="cms-settings-fields">
          <label htmlFor="cms-current-password">当前密码
            <input id="cms-current-password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={1024} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
          </label>
          <label htmlFor="cms-new-password">新密码
            <input id="cms-new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} aria-describedby="cms-password-hint" value={newPassword} onChange={event => setNewPassword(event.target.value)} />
            <small id="cms-password-hint">12 至 128 个字符，建议使用较长且不与其他网站重复的密码。</small>
          </label>
          <label htmlFor="cms-confirm-password">确认新密码
            <input id="cms-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} />
          </label>
        </div>
      </section>
      <div className="cms-settings-save"><span>更改成功后，请使用新密码重新登入。</span><button className="cms-primary" type="submit">{busy ? <LoaderCircle size={16} className="cms-spin" /> : <KeyRound size={16} />}{busy ? "正在更改…" : "保存新密码"}</button></div>
    </fieldset>
  </form>;
}
