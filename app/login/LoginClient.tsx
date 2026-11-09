"use client";

import { useState } from "react";
import { ArrowLeft, ArrowUpRight, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from "lucide-react";
import { AdminThemeToggle, useAdminTheme } from "../components/AdminTheme";

function safeRedirect(value: unknown) {
  const fallback = "/login";
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith("//") || url.pathname === "/login" || url.pathname.startsWith("/api/")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return fallback; }
}

export default function LoginClient() {
  const { theme, setTheme } = useAdminTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const returnPaths = new URLSearchParams(window.location.search).getAll("return_to");
      const returnTo = returnPaths.length === 1 ? returnPaths[0] : undefined;
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", signal: controller.signal, body: JSON.stringify({ username: username.trim(), password, returnTo }) });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; redirect?: string; error?: string };
      if (!response.ok) {
        if (response.status === 503) throw new Error("管理服务暂未启用，请联系网站负责人完成设置。");
        if (response.status === 429) throw new Error(result.error || "登入尝试过于频繁，请稍后再试。");
        throw new Error(result.error || "登入失败，请检查账号和密码后重试。");
      }
      if (!result.ok) throw new Error("无法确认登入状态，请重试。");
      setPassword("");
      window.location.assign(safeRedirect(result.redirect));
    } catch (err) {
      setError(err instanceof Error && err.name === "AbortError" ? "连接超时，请检查网络后重试。" : err instanceof Error ? err.message : "暂时无法登入，请稍后重试。");
      setBusy(false);
    } finally { clearTimeout(timer); }
  }

  return <main className="login-shell" data-admin-theme={theme}>
    <a className="login-wordmark" href="/" aria-label="365freebonus 首页"><span>✳</span>365freebonus<i>.</i></a>
    <div className="login-top-actions"><AdminThemeToggle theme={theme} onChange={setTheme} /><a className="login-back" href="/"><ArrowLeft size={14} />返回首页</a></div>
    <div className="login-frame">
      <section className="login-visual" aria-hidden="true"><div className="login-grid" /><span className="login-visual-label">365FREEBONUS / CONTROL ROOM</span><div className="login-orbit"><i /><i /><i /><span>✳</span><b /></div><div className="login-visual-copy"><span>YOUR SPACE. YOUR VISION.</span><h2>把灵感，<br />变成每一次发现。</h2><p>一个专属空间，让品牌与内容井然有序。</p></div><span className="login-coordinate">01 / MANAGEMENT WORKSPACE</span></section>
      <section className="login-panel" aria-labelledby="login-title"><div className="login-lock"><KeyRound size={24} strokeWidth={1.5} /></div><span className="login-eyebrow">WELCOME BACK</span><h1 id="login-title">管理员登入</h1><p className="login-intro">登入管理后台，继续打造你的网站。</p>
        <form onSubmit={submit} aria-busy={busy}>
          {error && <div className="login-error" role="alert">{error}</div>}
          <fieldset disabled={busy}><label htmlFor="login-username">管理员账号</label><div className="login-input-wrap"><UserRound size={17} /><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="admin" required maxLength={100} value={username} onChange={event => setUsername(event.target.value)} autoFocus /></div>
          <label htmlFor="login-password">密码</label><div className="login-input-wrap"><LockKeyhole size={16} /><input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="输入管理员密码" required maxLength={300} value={password} onChange={event => setPassword(event.target.value)} /><button type="button" className="login-eye" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          <button className="login-submit" type="submit">{busy ? <><LoaderCircle size={17} />正在登入…</> : <>登入后台<ArrowUpRight size={18} /></>}</button></fieldset>
        </form>
        <div className="login-security"><ShieldCheck size={15} /><span>仅供授权管理员使用</span></div>
      </section>
    </div>
    <footer className="login-footer"><span>365freebonus</span><span>CONTENT MANAGEMENT</span></footer>
  </main>;
}
