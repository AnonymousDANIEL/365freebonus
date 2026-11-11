"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleHelp, Globe, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import "./website-logins-admin.css";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Website = {
  id: number; name: string; loginUrl: string; verifyUrl: string; successText: string;
  username: string; usernameField: string; passwordField: string; enabled: boolean;
  intervalMinutes: number; status: "idle" | "running" | "success" | "error";
  message: string; lastAttemptAt: number | null; lastSuccessAt: number | null; hasPassword: boolean;
};
type WebsitePage = { websites: Website[]; total: number; page: number; pageSize: number };
type FormData = Pick<Website, "name" | "loginUrl" | "verifyUrl" | "successText" | "username" | "usernameField" | "passwordField" | "enabled" | "intervalMinutes"> & { password: string };
const emptyForm = (): FormData => ({ name: "", loginUrl: "", verifyUrl: "", successText: "", username: "", password: "", usernameField: "", passwordField: "", enabled: false, intervalMinutes: 30 });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function formatTime(value: number | null) { return value && Number.isFinite(value) ? timeFormat.format(value) : "—"; }
const statusLabels = { idle: "等待运行", running: "正在登录", success: "验证成功", error: "需要检查" };

export default function WebsiteLogins({ request, signInPath }: { request: AdminRequest; signInPath: string }) {
  const [data, setData] = useState<WebsitePage>({ websites: [], total: 0, page: 1, pageSize: 20 });
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [editor, setEditor] = useState<{ id: number | null; hasPassword: boolean } | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [deleting, setDeleting] = useState<Website | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const saving = useRef(false);
  const reload = () => setRefresh(value => value + 1);

  function fail(value: unknown) {
    setError(value instanceof Error ? value.message : "操作失败，请稍后重试。");
    setSessionExpired(value instanceof Error && "status" in value && value.status === 401);
  }

  useEffect(() => {
    let active = true;
    let timer = 0;
    let inFlight = false;
    setLoading(true);
    async function load(initial = false) {
      if (inFlight) return;
      if (!initial && document.hidden) { timer = window.setTimeout(() => { void load(); }, 5000); return; }
      inFlight = true;
      let expired = false;
      try {
        const result = await request<WebsitePage>(`/api/admin/websites?page=${page}`);
        if (!active) return;
        if (result.page !== page) { setPage(result.page); return; }
        setData(result);
        setSessionExpired(false);
      } catch (value) {
        if (!active) return;
        expired = value instanceof Error && "status" in value && value.status === 401;
        fail(value);
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          if (!expired) timer = window.setTimeout(() => { void load(); }, 5000);
        }
      }
    }
    void load(true);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page, refresh, request]);

  useEffect(() => { if (sessionExpired) setForm(previous => ({ ...previous, password: "" })); }, [sessionExpired]);

  useEffect(() => {
    if (deleting) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [deleting]);

  function edit(website?: Website) {
    setError(""); setSuccess("");
    setEditor({ id: website?.id ?? null, hasPassword: website?.hasPassword ?? false });
    setForm(website ? {
      name: website.name, loginUrl: website.loginUrl, verifyUrl: website.verifyUrl, successText: website.successText,
      username: website.username, password: "", usernameField: website.usernameField, passwordField: website.passwordField,
      enabled: website.enabled, intervalMinutes: website.intervalMinutes,
    } : emptyForm());
  }
  function closeEditor() { setEditor(null); setForm(emptyForm()); }
  function field<K extends keyof FormData>(key: K, value: FormData[K]) { setForm(previous => ({ ...previous, [key]: value })); }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving.current) return;
    setError(""); setSuccess("");
    try {
      const login = new URL(form.loginUrl), verify = new URL(form.verifyUrl);
      if (login.protocol !== "https:" || verify.protocol !== "https:" || login.origin !== verify.origin) throw new Error("登录网址和检查网址需要使用同一个网站的 HTTPS 地址。");
      if (!form.successText.trim()) throw new Error("请填写登录后才会出现的成功识别文字。");
      if (!Number.isInteger(form.intervalMinutes) || form.intervalMinutes < 15 || form.intervalMinutes > 1440) throw new Error("检查间隔需要是 15 至 1440 分钟。");
    } catch (value) { setError(value instanceof TypeError ? "请输入完整的网址。" : value instanceof Error ? value.message : "请检查填写内容。"); return; }
    saving.current = true; setBusy("save");
    try {
      await request<{ website: Website }>(editor.id === null ? "/api/admin/websites" : `/api/admin/websites/${editor.id}`, editor.id === null ? "POST" : "PUT", form);
      const enabled = form.enabled;
      closeEditor();
      setSuccess(enabled ? "网站已保存，将按设定的间隔自动登录。可点击“立即登录”查看首次结果。" : "网站已保存。点击“立即登录”可验证账号与登录方式。");
      reload();
    } catch (value) { fail(value); field("password", ""); }
    finally { saving.current = false; setBusy(""); }
  }

  async function startLogin(website: Website) {
    if (saving.current) return;
    saving.current = true; setBusy(`login-${website.id}`); setError(""); setSuccess("");
    try {
      await request<{ ok: boolean; website: Website }>(`/api/admin/websites/${website.id}/login`, "POST", {});
      setSuccess(`${website.name} 已加入登录队列，运行结果会自动刷新。`);
      reload();
    } catch (value) { fail(value); }
    finally { saving.current = false; setBusy(""); }
  }

  async function remove() {
    if (!deleting || saving.current) return;
    saving.current = true; setBusy("delete"); setError(""); setSuccess("");
    try {
      await request(`/api/admin/websites/${deleting.id}`, "DELETE");
      setDeleting(null); setSuccess("网站登录配置已删除。"); reload();
    } catch (value) { fail(value); }
    finally { saving.current = false; setBusy(""); }
  }

  const disabled = Boolean(busy) || sessionExpired;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <div className="cms-websites">
    <div className="cms-websites-intro"><div><ShieldCheck size={20} /><div><strong>网站账号自动登录</strong><p>用于你有权限的普通非博彩网站。支持标准网页表单，登录结果会在这里验证和显示。</p></div></div><button type="button" className="cms-primary" disabled={disabled} onClick={() => edit()}><Plus size={16} />添加网站</button></div>
    <p className="cms-websites-hint"><CircleHelp size={15} />后台代为登录并检查连接，不会把登录状态同步到你当前浏览器。验证失败后会自动停用，检查配置后可再手动尝试。</p>
    <p className="cms-websites-hint"><CircleHelp size={15} />遇到验证码、双重验证、第三方单点登录或仅靠 JavaScript 提交的页面时，需要人工处理或专门接入。</p>
    {error && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <a className="cms-reauth" href={signInPath}>重新登入 ↗</a>}<button type="button" aria-label="关闭错误" onClick={() => setError("")}><X size={16} /></button></div>}
    {success && <div className="cms-alert cms-success" role="status"><Check size={17} /><span>{success}</span></div>}
    {editor && <form className="cms-settings-form cms-websites-editor" autoComplete="off" onSubmit={save}>
      <fieldset disabled={disabled}>
        <section className="cms-settings-panel"><div><h2>{editor.id === null ? "添加网站" : "编辑网站"}</h2><p>密码加密保存。登录完成后，会访问检查网址，确认成功识别文字是否出现。</p></div><div className="cms-settings-fields">
          <label>网站名称<input required maxLength={120} value={form.name} onChange={event => field("name", event.target.value)} placeholder="例如：客户服务平台" /></label>
          <label>登录网址<input type="url" required maxLength={2048} value={form.loginUrl} onChange={event => field("loginUrl", event.target.value)} placeholder="https://accounts.example.com/login" /></label>
          <label>登录后检查网址<input type="url" required maxLength={2048} value={form.verifyUrl} onChange={event => field("verifyUrl", event.target.value)} placeholder="https://accounts.example.com/account" /><small>填写登录后才能访问的同站页面。</small></label>
          <label>成功识别文字<input required minLength={2} maxLength={200} value={form.successText} onChange={event => field("successText", event.target.value)} placeholder="例如：退出登录" /><small>选择登录后才出现的文字，不能使用登录页本身就有的内容。</small></label>
          <label>账号<input required maxLength={256} name="websiteAccount" autoComplete="off" autoCapitalize="none" spellCheck={false} value={form.username} onChange={event => field("username", event.target.value)} /></label>
          <label>密码<input type="password" name="websitePassword" autoComplete="new-password" required={!editor.hasPassword} maxLength={1024} value={form.password} onChange={event => field("password", event.target.value)} placeholder={editor.hasPassword ? "已保存，留空继续使用" : "填写网站账号密码"} /><small>{editor.hasPassword ? "编辑时留空沿用已保存密码，填写新密码则替换。" : "只在这个后台填写，无需发送到聊天里。"}</small></label>
          <label className="cms-websites-check"><input type="checkbox" checked={form.enabled} onChange={event => field("enabled", event.target.checked)} /><span>启用自动登录</span></label>
          <label>检查间隔（分钟）<input type="number" min={15} max={1440} step={1} required value={form.intervalMinutes} onChange={event => field("intervalMinutes", event.target.valueAsNumber)} /><small>15 至 1440 分钟，服务运行时按间隔执行。</small></label>
          <details className="cms-websites-advanced"><summary>高级：指定表单字段</summary><p>一般可自动识别。只有网站使用特殊字段名称时才需要填写。</p><label>账号字段名称<input maxLength={100} value={form.usernameField} onChange={event => field("usernameField", event.target.value)} placeholder="留空自动识别" /></label><label>密码字段名称<input maxLength={100} value={form.passwordField} onChange={event => field("passwordField", event.target.value)} placeholder="留空自动识别" /></label></details>
        </div></section>
        <div className="cms-settings-save"><button type="button" className="cms-secondary" onClick={closeEditor}>取消</button><button type="submit" className="cms-primary">{busy === "save" ? <LoaderCircle size={16} className="cms-spin" /> : <Check size={16} />}保存网站</button></div>
      </fieldset>
    </form>}
    <section className="cms-brand-panel">
      <div className="cms-panel-tools"><strong>已添加网站 <span className="cms-websites-total">{data.total}</span></strong><button type="button" className="cms-secondary" disabled={loading || disabled} onClick={reload}><RefreshCw size={15} className={loading ? "cms-spin" : undefined} />刷新状态</button></div>
      {loading && !data.websites.length ? <div className="cms-loading"><LoaderCircle size={25} /><p>正在加载网站…</p></div> : !data.websites.length ? <div className="cms-empty"><Globe size={28} /><h3>添加第一个网站</h3><p>添加登录网址和账号后，即可保存配置并验证登录。</p></div> : <div className="cms-table-scroll"><table className="cms-table cms-websites-table"><thead><tr><th>网站 / 账号</th><th>登录状态</th><th>自动登录</th><th>最近运行（马来西亚时间）</th><th>操作</th></tr></thead><tbody>{data.websites.map(website => <tr key={website.id}>
        <td><div className="cms-websites-name"><strong>{website.name}</strong><span title={website.loginUrl}>{website.loginUrl}</span><small>{website.username}</small></div></td>
        <td><span className={`cms-websites-status ${website.status}`}>{website.status === "running" && <LoaderCircle size={13} className="cms-spin" />}{statusLabels[website.status]}</span><small className="cms-websites-message">{website.message || "尚未运行登录验证。"}</small></td>
        <td><span>{website.enabled ? "已开启" : "已关闭"}</span><small className="cms-websites-message">每 {website.intervalMinutes} 分钟</small></td>
        <td><span>{formatTime(website.lastAttemptAt)}</span><small className="cms-websites-message">最近成功：{formatTime(website.lastSuccessAt)}</small></td>
        <td><div className="cms-websites-actions"><button type="button" className="cms-secondary" disabled={disabled || website.status === "running"} onClick={() => { void startLogin(website); }}><LogIn size={14} />立即登录</button><button type="button" className="cms-websites-icon" aria-label={`编辑 ${website.name}`} disabled={disabled || website.status === "running"} onClick={() => edit(website)}><Pencil size={15} /></button><button type="button" className="cms-websites-icon cms-websites-remove" aria-label={`删除 ${website.name}`} disabled={disabled || website.status === "running"} onClick={() => setDeleting(website)}><Trash2 size={15} /></button></div></td>
      </tr>)}</tbody></table></div>}
      <div className="cms-panel-footer"><span>共 {data.total} 个网站 · 第 {page} / {pages} 页</span><div className="cms-websites-pages"><button type="button" className="cms-secondary" disabled={page <= 1 || loading || disabled} onClick={() => setPage(value => value - 1)}>上一页</button><button type="button" className="cms-secondary" disabled={page >= pages || loading || disabled} onClick={() => setPage(value => value + 1)}>下一页</button></div></div>
    </section>
    <dialog ref={deleteDialog} className="cms-confirm cms-websites-delete" onCancel={event => { event.preventDefault(); if (!busy) setDeleting(null); }}>
      {deleting && <><h2>删除网站登录配置？</h2>{error && <div className="cms-alert cms-error" role="alert">{error}</div>}<p>将移除“{deleting.name}”的已保存账号和自动登录安排。不会删除该网站上的账户。</p><div className="cms-confirm-actions"><button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>取消</button><button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => { void remove(); }}>{busy === "delete" ? <LoaderCircle size={15} className="cms-spin" /> : <Trash2 size={15} />}确认删除</button></div></>}
    </dialog>
  </div>;
}
