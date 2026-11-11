"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleHelp, KeyRound, LoaderCircle, LockKeyhole, NotebookPen, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UnlockKeyhole, X } from "lucide-react";
import "./secure-notes-admin.css";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Vault = { configured: boolean; unlocked: boolean; expiresAt: number | null };
type Note = { id: number; title: string; body: string; createdAt: number; updatedAt: number; revision: string };
type NotePage = { notes: Note[]; total: number; page: number; pageSize: number; expiresAt: number };
const emptyPage = (): NotePage => ({ notes: [], total: 0, page: 1, pageSize: 20, expiresAt: 0 });
const emptyCredentials = () => ({ pin: "", confirmPin: "", currentPassword: "", currentPin: "", newPin: "" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const time = (value: number) => timeFormat.format(value);
const pinValue = (value: string) => value.replace(/[^0-9]/g, "").slice(0, 12);
function errorStatus(error: unknown): number { return error instanceof Error && "status" in error ? Number(error.status) : 0; }

// A best-effort server revocation also runs when React unmounts or the tab hides.
// No note content, PIN, or password is included in this request.
async function lockRemote() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch("/api/admin/notes/vault", { method: "POST", credentials: "same-origin", cache: "no-store", keepalive: true, signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "lock" }) });
  } catch { /* The view stays locked even if the network is unavailable. */ }
  finally { clearTimeout(timer); }
}

export default function SecureNotes({ request, signInPath }: { request: AdminRequest; signInPath: string }) {
  const [vault, setVault] = useState<Vault | null>(null);
  const [data, setData] = useState<NotePage>(emptyPage);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [credentials, setCredentials] = useState(emptyCredentials);
  const [changingPin, setChangingPin] = useState(false);
  const [editor, setEditor] = useState<{ id: number | null; revision: string } | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deleting, setDeleting] = useState<Note | null>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const firstCredential = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const submitting = useRef(false);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  function accepts(version: number) { return mounted.current && generation.current === version && !document.hidden; }
  function clearSensitive() {
    setData(emptyPage()); setEditor(null); setTitle(""); setBody(""); setDeleting(null);
    setCredentials(emptyCredentials()); setChangingPin(false);
  }
  function lock(reason = "安全笔记已锁定。") {
    generation.current++;
    clearSensitive(); setError(""); setMessage(reason);
    setVault(previous => previous?.configured ? { ...previous, unlocked: false, expiresAt: null } : null);
    setLoading(false);
    void lockRemote();
  }
  function fail(value: unknown, version: number) {
    if (!accepts(version)) return;
    const status = errorStatus(value);
    if (status === 401 || status === 423) {
      generation.current++; clearSensitive();
      setVault(previous => previous ? { ...previous, unlocked: false, expiresAt: null } : previous);
      setLoading(false);
      setSessionExpired(status === 401); void lockRemote();
    }
    setError(value instanceof Error ? value.message : "操作失败，请稍后重试。");
    setMessage("");
  }
  async function loadNotes(page: number, version: number) {
    if (!accepts(version)) return;
    const result = await request<NotePage>(`/api/admin/notes?page=${page}`);
    if (!accepts(version)) return;
    if (!Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) { lock("解锁时间已到，请重新输入 PIN。"); return; }
    setData(result);
    setVault(previous => previous ? { ...previous, unlocked: true, expiresAt: result.expiresAt } : previous);
  }

  useEffect(() => {
    mounted.current = true;
    const version = ++generation.current;
    // Re-entering this section always starts locked, including after a failed
    // background revocation. Status alone never triggers plaintext loading.
    void (async () => {
      await lockRemote();
      try {
        const result = await request<Vault>("/api/admin/notes/vault");
        if (accepts(version)) setVault({ ...result, unlocked: false, expiresAt: null });
      } catch (value) { fail(value, version); }
      finally { if (mounted.current && generation.current === version) setLoading(false); }
    })();
    const hide = () => {
      if (document.hidden) lock("离开页面后已自动锁定，请重新输入 PIN。");
      else if (!vaultRef.current && !submitting.current) void retryStatus();
    };
    const checkExpiry = () => {
      const current = vaultRef.current;
      if (current?.unlocked && (!current.expiresAt || current.expiresAt <= Date.now())) lock("解锁时间已到，请重新输入 PIN。");
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("focus", checkExpiry);
    return () => {
      mounted.current = false; generation.current++;
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("focus", checkExpiry);
      void lockRemote();
    };
    // The parent request helper is stable and all pending responses are guarded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (!vault?.unlocked || !vault.expiresAt) return;
    const remaining = vault.expiresAt - Date.now();
    if (remaining <= 0) { lock("解锁时间已到，请重新输入 PIN。"); return; }
    const timer = window.setTimeout(() => lock("解锁时间已到，请重新输入 PIN。"), remaining);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault?.unlocked, vault?.expiresAt]);

  useEffect(() => {
    if (!loading && vault && !vault.unlocked && !busy && !document.hidden) firstCredential.current?.focus();
  }, [loading, vault?.configured, vault?.unlocked, busy]);

  useEffect(() => {
    if (deleting) deleteDialog.current?.showModal(); else deleteDialog.current?.close();
  }, [deleting]);

  async function vaultAction(event: FormEvent<HTMLFormElement>, action: "setup" | "unlock" | "changePin") {
    event.preventDefault();
    if (submitting.current || sessionExpired || document.hidden) return;
    const entered = credentials;
    setCredentials(emptyCredentials()); setError(""); setMessage("");
    const newPin = action === "changePin" ? entered.newPin : entered.pin;
    if (action !== "unlock" && (!/^[0-9]{6,12}$/.test(newPin) || newPin !== entered.confirmPin)) {
      setError("PIN 需要 6 至 12 位数字，且两次输入一致。"); return;
    }
    const payload = action === "setup" ? { action, pin: entered.pin, confirmPin: entered.confirmPin, currentPassword: entered.currentPassword }
      : action === "changePin" ? { action, currentPin: entered.currentPin, newPin: entered.newPin, confirmPin: entered.confirmPin }
      : { action, pin: entered.pin };
    const version = generation.current;
    submitting.current = true; setBusy(action);
    try {
      const result = await request<Vault>("/api/admin/notes/vault", "POST", payload);
      if (!accepts(version)) { await lockRemote(); return; }
      if (action === "changePin") {
        clearSensitive(); setVault({ ...result, unlocked: false, expiresAt: null });
        setMessage("PIN 已更改，所有笔记解锁已失效。请使用新 PIN 解锁。");
      } else {
        setVault(result);
        if (result.unlocked) {
          await loadNotes(1, version);
          if (accepts(version)) setMessage(action === "setup" ? "PIN 已设置，可以开始记录。" : "安全笔记已解锁。");
        }
      }
    } catch (value) { fail(value, version); }
    finally {
      submitting.current = false;
      if (mounted.current) setBusy("");
      // A hidden/unmounted view must revoke an unlock that completed after its
      // first lock request, rather than leaving a valid cookie behind.
      if (!accepts(version) && action !== "changePin") {
        void lockRemote();
        if (mounted.current && !document.hidden && !vaultRef.current) void retryStatus();
      }
    }
  }

  function edit(note?: Note) {
    if (submitting.current || !vault?.unlocked) return;
    setError(""); setMessage("");
    setEditor({ id: note?.id ?? null, revision: note?.revision ?? "" });
    setTitle(note?.title ?? ""); setBody(note?.body ?? "");
  }
  function closeEditor() { setEditor(null); setTitle(""); setBody(""); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || submitting.current || !vault?.unlocked || document.hidden) return;
    const version = generation.current;
    const current = editor;
    submitting.current = true; setBusy("save"); setError(""); setMessage("");
    try {
      await request<{ note: Note }>(current.id === null ? "/api/admin/notes" : `/api/admin/notes/${current.id}`, current.id === null ? "POST" : "PUT", { title, body, ...(current.id === null ? {} : { expectedRevision: current.revision }) });
      if (!accepts(version)) return;
      closeEditor(); await loadNotes(current.id === null ? 1 : data.page, version);
      if (accepts(version)) setMessage("笔记已保存。");
    } catch (value) { fail(value, version); }
    finally { submitting.current = false; if (mounted.current) setBusy(""); }
  }
  async function remove() {
    if (!deleting || submitting.current || !vault?.unlocked || document.hidden) return;
    const version = generation.current;
    const current = deleting;
    submitting.current = true; setBusy("delete"); setError(""); setMessage("");
    try {
      await request(`/api/admin/notes/${current.id}`, "DELETE", { expectedRevision: current.revision });
      if (!accepts(version)) return;
      if (editor?.id === current.id) closeEditor();
      setDeleting(null); await loadNotes(data.page, version);
      if (accepts(version)) setMessage("笔记已删除。");
    } catch (value) { fail(value, version); }
    finally { submitting.current = false; if (mounted.current) setBusy(""); }
  }
  async function refresh(page = data.page) {
    if (submitting.current || !vault?.unlocked || document.hidden) return;
    const version = generation.current;
    submitting.current = true; setBusy("load"); setError("");
    try { await loadNotes(page, version); }
    catch (value) { fail(value, version); }
    finally { submitting.current = false; if (mounted.current) setBusy(""); }
  }
  async function retryStatus() {
    if (submitting.current || document.hidden) return;
    const version = generation.current;
    submitting.current = true; setBusy("status"); setError("");
    try {
      await lockRemote();
      const result = await request<Vault>("/api/admin/notes/vault");
      if (accepts(version)) { setVault({ ...result, unlocked: false, expiresAt: null }); setLoading(false); }
    } catch (value) { fail(value, version); }
    finally { submitting.current = false; if (mounted.current) setBusy(""); }
  }
  function pinField(key: "pin" | "confirmPin" | "currentPin" | "newPin", label: string, autoComplete = "off") {
    return <label>{label}<input ref={key === "pin" && vault?.configured ? firstCredential : undefined} autoFocus={key === "currentPin"} name={`notes-${key}`} type="password" inputMode="numeric" autoComplete={autoComplete} pattern="[0-9]{6,12}" required minLength={6} maxLength={12} value={credentials[key]} onChange={event => setCredentials(previous => ({ ...previous, [key]: pinValue(event.target.value) }))} /></label>;
  }

  const disabled = Boolean(busy) || loading || sessionExpired;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <div className="cms-notes">
    <div className="cms-notes-intro"><ShieldCheck size={21} /><div><strong>私人记录 · 独立 PIN 保护</strong><p>记录加密保存。后台登入后，还需要输入 PIN 才能查看或修改。</p></div>{vault?.unlocked && <button className="cms-secondary" type="button" onClick={() => lock()}><LockKeyhole size={15} />立即锁定</button>}</div>
    {error && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}<button type="button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={16} /></button></div>}
    {message && <div className="cms-alert cms-success" role="status"><Check size={17} /><span>{message}</span></div>}
    {loading ? <div className="cms-loading"><LoaderCircle size={27} /><p>正在检查笔记锁…</p></div> : !vault ? <div className="cms-notes-lock"><CircleHelp size={30} /><h2>暂时无法读取笔记状态</h2><p>笔记保持锁定，请重新检查连接。</p><button type="button" className="cms-secondary" disabled={disabled} onClick={() => { void retryStatus(); }}><RefreshCw size={15} />重新加载</button></div> : !vault.unlocked ? <form className="cms-settings-form cms-notes-lock-form" autoComplete="off" onSubmit={event => { void vaultAction(event, vault.configured ? "unlock" : "setup"); }}>
      <fieldset disabled={disabled}>
        <section className="cms-settings-panel cms-notes-lock-panel"><div><div className="cms-notes-lock-symbol"><LockKeyhole size={27} /></div><h2>{vault.configured ? "解锁安全笔记" : "设置笔记 PIN"}</h2><p>{vault.configured ? "输入独立 PIN，查看和管理你的私人记录。" : "首次使用先验证后台密码，再设置专用 PIN。"}</p></div><div className="cms-settings-fields">
          {!vault.configured && <label>当前后台密码<input ref={firstCredential} name="notes-current-password" type="password" autoComplete="current-password" required maxLength={1024} value={credentials.currentPassword} onChange={event => setCredentials(previous => ({ ...previous, currentPassword: event.target.value }))} /></label>}
          {pinField("pin", vault.configured ? "笔记 PIN" : "新 PIN")}
          {!vault.configured && pinField("confirmPin", "确认 PIN")}
          <small>PIN 为 6 至 12 位数字。请妥善保存，不提供绕过 PIN 的解锁入口。</small>
          <button className="cms-primary" type="submit">{busy === "unlock" || busy === "setup" ? <LoaderCircle size={16} className="cms-spin" /> : <UnlockKeyhole size={16} />}{vault.configured ? "解锁笔记" : "设置 PIN 并开始使用"}</button>
        </div></section>
      </fieldset>
    </form> : <>
      <div className="cms-notes-toolbar"><div><span className="cms-notes-unlocked"><UnlockKeyhole size={14} />已解锁</span><small>最晚 {time(vault.expiresAt!)}（马来西亚时间）自动锁定</small></div><div><button type="button" className="cms-secondary" disabled={disabled} onClick={() => { setChangingPin(value => !value); setCredentials(emptyCredentials()); }}><KeyRound size={15} />更改 PIN</button><button type="button" className="cms-primary" disabled={disabled} onClick={() => edit()}><Plus size={16} />新增笔记</button></div></div>
      <p className="cms-notes-hint"><LockKeyhole size={14} />离开这个栏目、切换到其他标签页或解锁满 15 分钟，笔记会自动锁定。</p>
      {changingPin && <form className="cms-settings-form" autoComplete="off" onSubmit={event => { void vaultAction(event, "changePin"); }}><fieldset disabled={disabled}><section className="cms-settings-panel"><div><h2>更改笔记 PIN</h2><p>需要验证当前 PIN。保存后，所有设备都需要重新解锁笔记。</p></div><div className="cms-settings-fields">{pinField("currentPin", "当前 PIN")}{pinField("newPin", "新 PIN")}{pinField("confirmPin", "确认新 PIN")}<div className="cms-notes-form-actions"><button type="button" className="cms-secondary" onClick={() => { setChangingPin(false); setCredentials(emptyCredentials()); }}>取消</button><button type="submit" className="cms-primary">{busy === "changePin" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}保存新 PIN</button></div></div></section></fieldset></form>}
      {editor && <form className="cms-settings-form cms-notes-editor" autoComplete="off" onSubmit={event => { void save(event); }}><fieldset disabled={disabled}><section className="cms-settings-panel"><div><h2>{editor.id === null ? "新增笔记" : "查看 / 编辑笔记"}</h2><p>填写标题和内容，保存为私人记录。</p></div><div className="cms-settings-fields"><label>标题<input name="notes-title" required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="给这条记录一个名称" /></label><label>内容<textarea name="notes-body" required rows={10} maxLength={8000} spellCheck={false} value={body} onChange={event => setBody(event.target.value)} placeholder="在这里记录内容…" /><small>{body.length} / 8000</small></label><div className="cms-notes-form-actions"><button type="button" className="cms-secondary" onClick={closeEditor}>取消</button><button type="submit" className="cms-primary">{busy === "save" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}保存笔记</button></div></div></section></fieldset></form>}
      <section className="cms-brand-panel cms-notes-records"><div className="cms-panel-tools"><strong>我的笔记 <span className="cms-notes-total">{data.total}</span></strong><button type="button" className="cms-secondary" disabled={disabled} onClick={() => { void refresh(); }}><RefreshCw size={15} className={busy === "load" ? "cms-spin" : undefined} />刷新</button></div>
        {!data.notes.length ? <div className="cms-empty"><NotebookPen size={29} /><h3>开始你的第一条记录</h3><p>点击“新增笔记”，保存需要留存的内容。</p></div> : <div className="cms-notes-grid">{data.notes.map(note => <article className="cms-note-card" key={note.id}><div className="cms-note-heading"><NotebookPen size={17} /><h3>{note.title}</h3></div><p>{note.body.length > 140 ? `${note.body.slice(0, 140)}…` : note.body}</p><small>更新于 {time(note.updatedAt)}</small><div className="cms-note-actions"><button type="button" className="cms-secondary" disabled={disabled} onClick={() => edit(note)}><Pencil size={14} />查看 / 编辑</button><button type="button" className="cms-notes-delete" aria-label={`删除 ${note.title}`} disabled={disabled} onClick={() => { setError(""); setDeleting(note); }}><Trash2 size={15} /></button></div></article>)}</div>}
        <div className="cms-panel-footer"><span>共 {data.total} 条记录 · 第 {data.page} / {pages} 页</span><div className="cms-notes-pages"><button type="button" className="cms-secondary" disabled={disabled || data.page <= 1} onClick={() => { void refresh(data.page - 1); }}>上一页</button><button type="button" className="cms-secondary" disabled={disabled || data.page >= pages} onClick={() => { void refresh(data.page + 1); }}>下一页</button></div></div>
      </section>
    </>}
    <dialog ref={deleteDialog} className="cms-confirm cms-notes-confirm" onCancel={event => { event.preventDefault(); if (!busy) setDeleting(null); }}>{deleting && <><h2>删除这条笔记？</h2>{error && <div className="cms-alert cms-error" role="alert">{error}</div>}<p>“{deleting.title}”删除后无法恢复。</p><div className="cms-confirm-actions"><button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>取消</button><button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => { void remove(); }}>{busy === "delete" ? <LoaderCircle size={15} className="cms-spin" /> : <Trash2 size={15} />}确认删除</button></div></>}</dialog>
  </div>;
}
