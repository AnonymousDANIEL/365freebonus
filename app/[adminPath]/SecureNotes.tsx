"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleHelp, KeyRound, LoaderCircle, LockKeyhole, NotebookPen, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UnlockKeyhole, X } from "lucide-react";
import { NOTES_ACTIVITY_EVENT, type NotesVaultStatus } from "./NotesActivity";
import "./secure-notes-admin.css";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Vault = NotesVaultStatus;
type Note = { id: number; title: string; body: string; createdAt: number; updatedAt: number; revision: string };
type NotePage = { notes: Note[]; total: number; page: number; pageSize: number; expiresAt: number };
const emptyPage = (): NotePage => ({ notes: [], total: 0, page: 1, pageSize: 20, expiresAt: 0 });
const emptyCredentials = () => ({ pin: "", confirmPin: "", currentPassword: "", currentPin: "", newPin: "" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const time = (value: number) => timeFormat.format(value);
const pinValue = (value: string) => value.replace(/[^0-9]/g, "").slice(0, 12);
function errorStatus(error: unknown): number { return error instanceof Error && "status" in error ? Number(error.status) : 0; }

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
  const readSequence = useRef(0);
  const submitting = useRef(false);
  const statusReading = useRef(false);
  const statusAgain = useRef(false);
  const manualLock = useRef(false);
  const vaultRef = useRef(vault);
  const pageRef = useRef(1);
  vaultRef.current = vault;
  pageRef.current = data.page;

  function accepts(version: number) { return mounted.current && generation.current === version && !document.hidden; }
  function clearSensitive() {
    setData(emptyPage()); setEditor(null); setTitle(""); setBody(""); setDeleting(null);
    setCredentials(emptyCredentials()); setChangingPin(false);
  }
  function suspend() {
    generation.current++; readSequence.current++;
    clearSensitive(); setError(""); setMessage(""); setVault(null); setLoading(true);
  }
  function showLocked(status?: Vault) {
    generation.current++; readSequence.current++;
    clearSensitive();
    setVault(status ? { ...status, unlocked: false, expiresAt: null } : previous => previous ? { ...previous, unlocked: false, expiresAt: null } : previous);
    setLoading(false);
  }
  function fail(value: unknown, version: number) {
    if (!accepts(version)) return;
    const status = errorStatus(value);
    if (status === 401 || status === 423) {
      showLocked(); setSessionExpired(status === 401);
    }
    setError(value instanceof Error ? value.message : "操作失败，请稍后重试。");
    setMessage("");
  }
  async function loadNotes(page: number, version: number) {
    if (!accepts(version) || manualLock.current) return;
    const sequence = ++readSequence.current;
    const result = await request<NotePage>(`/api/admin/notes?page=${page}`);
    if (!accepts(version) || sequence !== readSequence.current || manualLock.current) return;
    if (!Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) {
      suspend(); void reconcileStatus(); return;
    }
    setData(result);
    setVault(previous => previous ? { ...previous, unlocked: true, expiresAt: Math.max(previous.expiresAt || 0, result.expiresAt) } : previous);
  }
  async function reconcileStatus() {
    if (!mounted.current || document.hidden || manualLock.current) return;
    if (statusReading.current) { statusAgain.current = true; return; }
    statusReading.current = true;
    const version = generation.current;
    try {
      const result = await request<Vault>("/api/admin/notes/vault");
      if (!accepts(version) || manualLock.current) return;
      if (!result.unlocked || !result.expiresAt || result.expiresAt <= Date.now()) showLocked(result);
      else {
        setVault(result); setSessionExpired(false);
        await loadNotes(pageRef.current, version);
      }
    } catch (value) { fail(value, version); }
    finally {
      statusReading.current = false;
      if (mounted.current && !document.hidden) setLoading(false);
      if (statusAgain.current && mounted.current && !document.hidden) {
        statusAgain.current = false; void reconcileStatus();
      }
    }
  }
  async function lock() {
    if (submitting.current || document.hidden) return;
    manualLock.current = true;
    const configured = vaultRef.current?.configured;
    showLocked({ configured: configured !== false, unlocked: false, expiresAt: null });
    const version = generation.current;
    submitting.current = true; setBusy("lock"); setError(""); setMessage("");
    try {
      const result = await request<Vault>("/api/admin/notes/vault", "POST", { action: "lock" });
      if (accepts(version)) {
        setVault({ ...result, unlocked: false, expiresAt: null }); setMessage("安全笔记已锁定。");
      }
    } catch (value) { fail(value, version); }
    finally { submitting.current = false; if (mounted.current) setBusy(""); }
  }

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    if (!document.hidden) void reconcileStatus();
    const visibility = () => {
      if (document.hidden) suspend();
      else if (manualLock.current) {
        setVault({ configured: true, unlocked: false, expiresAt: null }); setLoading(false);
      } else void reconcileStatus();
    };
    const checkExpiry = () => {
      const current = vaultRef.current;
      if (document.hidden || manualLock.current) return;
      if (!current || (current.unlocked && (!current.expiresAt || current.expiresAt <= Date.now()))) {
        suspend(); void reconcileStatus();
      }
    };
    const activity = (event: Event) => {
      if (!mounted.current || document.hidden || manualLock.current) return;
      const status = (event as CustomEvent<NotesVaultStatus>).detail;
      if (!status || typeof status.configured !== "boolean" || typeof status.unlocked !== "boolean") return;
      if (status.unlocked && Number.isFinite(status.expiresAt) && status.expiresAt! > Date.now()) {
        setVault(previous => previous?.unlocked ? { ...previous, expiresAt: Math.max(previous.expiresAt || 0, status.expiresAt!) } : previous);
      } else if (vaultRef.current?.unlocked && !submitting.current) {
        // Recheck passively: an activity response may predate a newer unlock.
        suspend(); void reconcileStatus();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", checkExpiry);
    window.addEventListener(NOTES_ACTIVITY_EVENT, activity);
    return () => {
      mounted.current = false; generation.current++; readSequence.current++;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", checkExpiry);
      window.removeEventListener(NOTES_ACTIVITY_EVENT, activity);
      // Unmount discards local plaintext; the HttpOnly unlock remains remembered.
    };
    // The parent request helper is stable; generation guards discard stale data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (!vault?.unlocked || !vault.expiresAt) return;
    const check = () => {
      if (document.hidden || manualLock.current) return;
      // Another tab may have renewed the server expiry; never revoke it here.
      suspend(); void reconcileStatus();
    };
    const timer = window.setTimeout(check, Math.max(0, vault.expiresAt - Date.now()));
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
    // A new explicit PIN action supersedes stale passive status reads.
    const version = ++generation.current;
    readSequence.current++;
    if (action !== "changePin") manualLock.current = false;
    submitting.current = true; setBusy(action);
    try {
      const result = await request<Vault>("/api/admin/notes/vault", "POST", payload);
      if (!accepts(version)) return;
      if (action === "changePin") {
        manualLock.current = true; showLocked(result);
        setMessage("PIN 已更改，所有笔记解锁已失效。请使用新 PIN 解锁。");
      } else {
        manualLock.current = false; setVault(result);
        if (result.unlocked) {
          await loadNotes(1, version);
          if (accepts(version)) setMessage(action === "setup" ? "PIN 已设置，可以开始记录。" : "安全笔记已解锁。");
        }
      }
    } catch (value) { fail(value, version); }
    finally {
      submitting.current = false;
      if (mounted.current) setBusy("");
      if (!accepts(version) && mounted.current && !document.hidden && !manualLock.current) void reconcileStatus();
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
    manualLock.current = false; setError(""); setLoading(true);
    await reconcileStatus();
  }
  function pinField(key: "pin" | "confirmPin" | "currentPin" | "newPin", label: string, autoComplete = "off") {
    return <label>{label}<input ref={key === "pin" && vault?.configured ? firstCredential : undefined} autoFocus={key === "currentPin"} name={`notes-${key}`} type="password" inputMode="numeric" autoComplete={autoComplete} pattern="[0-9]{6,12}" required minLength={6} maxLength={12} value={credentials[key]} onChange={event => setCredentials(previous => ({ ...previous, [key]: pinValue(event.target.value) }))} /></label>;
  }

  const disabled = Boolean(busy) || loading || sessionExpired;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <div className="cms-notes">
    <div className="cms-notes-intro"><ShieldCheck size={21} /><div><strong>私人记录 · 独立 PIN 保护</strong><p>记录加密保存。首次查看输入 PIN，解锁状态会在操作后台期间保留。</p></div>{vault?.unlocked && <button className="cms-secondary" type="button" disabled={Boolean(busy)} onClick={() => { void lock(); }}><LockKeyhole size={15} />立即锁定</button>}</div>
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
      <div className="cms-notes-toolbar"><div><span className="cms-notes-unlocked"><UnlockKeyhole size={14} />已解锁</span><small>若无后续操作，将于 {time(vault.expiresAt!)}（马来西亚时间）锁定</small></div><div><button type="button" className="cms-secondary" disabled={disabled} onClick={() => { setChangingPin(value => !value); setCredentials(emptyCredentials()); }}><KeyRound size={15} />更改 PIN</button><button type="button" className="cms-primary" disabled={disabled} onClick={() => edit()}><Plus size={16} />新增笔记</button></div></div>
      <p className="cms-notes-hint"><LockKeyhole size={14} />连续 12 小时未操作后台后自动锁定；切换栏目、标签页或刷新会保留解锁。</p>
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
