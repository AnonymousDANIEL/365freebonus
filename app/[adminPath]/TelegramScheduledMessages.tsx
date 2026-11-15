"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Check, Clock3, History, LoaderCircle, MessageSquareText, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { ScheduledMessagePlan, ScheduledMessagePlanInput, ScheduledMessageStatus } from "../lib/telegram-scheduled-messages-types";
import "./telegram-scheduled-messages-admin.css";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = { request: Request; signInPath: string };
type Notice = { message: string; error?: boolean; expired?: boolean };
type Tab = "plans" | "time" | "history";
const endpoint = "/api/admin/telegram/scheduled-messages";
const timezone = "Asia/Kuala_Lumpur";
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
const statusLabels: Record<string, string> = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", cancelled: "已取消", skipped: "已跳过" };
const tabs = [{ id: "plans", label: "文案管理", icon: MessageSquareText }, { id: "time", label: "时间管理", icon: CalendarClock }, { id: "history", label: "发送记录", icon: History }] as const;
const freshDraft = (): ScheduledMessagePlanInput => ({ requestId: crypto.randomUUID(), name: "", text: "", times: [""], enabled: false });
const displayTime = (value: number | null | undefined) => value ? timeFormat.format(value) : "—";
function draftOf(plan: ScheduledMessagePlan): ScheduledMessagePlanInput {
  return { id: plan.id, revision: plan.revision, name: plan.name, text: plan.text, times: [...plan.times], enabled: plan.enabled };
}
function failure(error: unknown): Notice {
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  return { error: true, expired: status === 401, message: status === 409 ? "这条计划已在其他页面修改。草稿已保留，请加载最新版本后再保存。" : error instanceof Error ? error.message : "暂时无法连接，请稍后重试。" };
}
function countdown(next: number | null, now: number): string {
  if (!next) return "尚未安排";
  const seconds = Math.max(0, Math.ceil((next - now) / 1000));
  if (!seconds) return "已到时间，正在检查发送";
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map(n => n.toString().padStart(2, "0")).join(":");
}
function dayStart(now: number) {
  const parts = dateFormat.formatToParts(now), value = (type: string) => parts.find(p => p.type === type)?.value || "";
  return Date.parse(`${value("year")}-${value("month")}-${value("day")}T00:00:00+08:00`);
}
function upcoming(plans: ScheduledMessagePlan[], now: number) {
  const rows: { id: string; plan: ScheduledMessagePlan; at: number }[] = [], start = dayStart(now);
  for (const plan of plans.filter(p => p.enabled)) {
    if (plan.nextRunAt && plan.nextRunAt <= now) rows.push({ id: `${plan.id}-due`, plan, at: plan.nextRunAt });
    for (let day = 0; day < 2; day++) for (const time of plan.times) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue;
      const [hour, minute] = time.split(":").map(Number), at = start + day * 86_400_000 + hour * 3_600_000 + minute * 60_000;
      if (at > now && at <= now + 86_400_000) rows.push({ id: `${plan.id}-${at}`, plan, at });
    }
  }
  return rows.sort((a, b) => a.at - b.at || a.plan.name.localeCompare(b.plan.name)).slice(0, 24);
}

export default function TelegramScheduledMessages({ request, signInPath }: Props) {
  const [status, setStatus] = useState<ScheduledMessageStatus | null>(null);
  const [tab, setTab] = useState<Tab>("plans");
  const [draft, setDraft] = useState<ScheduledMessagePlanInput | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [clientNow, setClientNow] = useState(() => Date.now());
  const [historyFilter, setHistoryFilter] = useState("all");
  const busyRef = useRef(false), epoch = useRef(0), anchor = useRef({ now: Date.now(), receivedAt: Date.now() });
  const editor = useRef<HTMLFormElement>(null);
  function accept(value: ScheduledMessageStatus) {
    anchor.current = { now: value.now, receivedAt: Date.now() }; setClientNow(Date.now()); setStatus(value);
  }
  useEffect(() => {
    let active = true, reading = false;
    async function read(initial = false) {
      if (reading || busyRef.current || !initial && document.visibilityState === "hidden") return;
      reading = true; const version = epoch.current;
      try { const value = await request<ScheduledMessageStatus>(endpoint); if (active && version === epoch.current) accept(value); }
      catch (error) { if (active && version === epoch.current) setNotice(failure(error)); }
      finally { reading = false; if (active) setLoading(false); }
    }
    void read(true);
    const poll = setInterval(() => void read(), 10_000), clock = setInterval(() => setClientNow(Date.now()), 1000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(poll); clearInterval(clock); document.removeEventListener("visibilitychange", visible); };
  }, [request]);
  useEffect(() => {
    if (draft && tab === "plans") { editor.current?.scrollIntoView({ block: "nearest" }); editor.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }
  }, [draft?.id, Boolean(draft), tab]);

  async function mutate(label: string, method: string, body?: unknown, success?: string) {
    if (busyRef.current) return false;
    busyRef.current = true; epoch.current++; setBusy(label); setNotice(null);
    try {
      accept(await request<ScheduledMessageStatus>(endpoint, method, body));
      if (success) setNotice({ message: success });
      return true;
    } catch (error) {
      setNotice(failure(error));
      if (error instanceof Error && "status" in error && error.status === 409) {
        try { accept(await request<ScheduledMessageStatus>(endpoint)); } catch { /* Keep the original conflict and draft. */ }
      }
      return false;
    } finally { busyRef.current = false; setBusy(""); setLoading(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    if (!draft.name.trim() || !draft.text.trim() || draft.text.length > 4096) { setNotice({ error: true, message: "请填写名称和文案，文案最多 4,096 个字符。" }); return; }
    if (!draft.times.length || draft.times.some(time => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || new Set(draft.times).size !== draft.times.length) {
      setNotice({ error: true, message: "请填写有效且不重复的每日发送时间。" }); return;
    }
    const payload = { ...draft, name: draft.name.trim(), times: [...draft.times].sort() };
    if (await mutate("save", draft.id ? "PUT" : "POST", payload, draft.enabled ? "文案及每日时间已保存，后台将自动向三个频道发送。" : "文案及每日时间已保存，计划处于暂停状态。")) setDraft(null);
  }
  function open(plan?: ScheduledMessagePlan) {
    if (draft && !window.confirm("放弃当前未保存的草稿？")) return;
    setDraft(plan ? draftOf(plan) : freshDraft()); setTab("plans"); setNotice(null);
  }
  async function remove(plan: ScheduledMessagePlan) {
    if (!window.confirm(`删除「${plan.name}」的每日计划？已发送的频道消息不会删除。`)) return;
    if (await mutate(`delete-${plan.id}`, "DELETE", { id: plan.id, revision: plan.revision }, "计划已删除，未发送的安排已取消。")) {
      if (draft?.id === plan.id) setDraft(null);
    }
  }
  const now = anchor.current.now + Math.max(0, clientNow - anchor.current.receivedAt);
  const plans = status?.plans || [], current = draft?.id ? plans.find(p => p.id === draft.id) : null;
  const conflict = Boolean(draft?.id && (!current || current.revision !== draft.revision));
  const enabledCount = plans.filter(p => p.enabled).length, next = status?.scheduler.nextRunAt || null;
  const heartbeat = status?.scheduler.heartbeatAt || 0;
  const healthy = Boolean(status?.scheduler.workerHealthy && heartbeat && now - heartbeat < 60_000);
  const targetsReady = Boolean(status?.hasToken && status.targets.length === 3 && status.targets.every(t => t.ready));
  const timeline = upcoming(plans, now);
  const deliveries = (status?.deliveries || []).filter(item => historyFilter === "all" || item.status === historyFilter);

  return <section className="cms-settings-form cms-scheduled-messages" aria-labelledby="scheduled-messages-title">
    <div className="cms-settings-panel">
      <div className="cms-scheduled-heading">
        <div><h2 id="scheduled-messages-title">频道文案定时发布</h2><p>添加文案与每日发送时间，同一时段自动发送到三个频道。</p></div>
        <div className="cms-scheduled-actions">
          <span className={`cms-scheduled-pill ${healthy ? "cms-scheduled-good" : ""}`}>{healthy ? "后台定时服务运行中" : loading ? "正在连接…" : "定时服务需要检查"}</span>
          <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => void mutate("refresh", "GET")}><RefreshCw size={14} className={busy === "refresh" ? "cms-spin" : ""} />刷新状态</button>
        </div>
      </div>
      {notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>{notice.message}{notice.expired && <a href={signInPath} target="_top">重新登入 ↗</a>}</div>}
      {loading && !status ? <p className="cms-scheduled-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载文案与每日计划…</p> : !status ?
        <div className="cms-scheduled-empty"><strong>暂时无法加载计划</strong><p>请刷新状态后重试。</p></div> : <>
        <div className="cms-scheduled-overview">
          <div><small><Clock3 size={13} />马来西亚时间（UTC+8）</small><strong>{displayTime(now)}</strong><span>后台检查：{displayTime(status.scheduler.lastCompletedAt || status.scheduler.lastTickAt)}</span></div>
          <div className="cms-scheduled-next"><small>下次自动发送</small><strong>{displayTime(next)}</strong><span>{countdown(next, now)}</span></div>
        </div>
        {status.scheduler.lastError && <p className="cms-scheduled-error" role="alert">运行异常 · {status.scheduler.lastError}</p>}
        <div className="cms-scheduled-tabs" role="tablist" aria-label="频道文案管理">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`scheduled-tab-${id}`} aria-controls={`scheduled-panel-${id}`} aria-selected={tab === id} onClick={() => setTab(id)}><Icon size={15} />{label}{id === "plans" && <small>{plans.length}</small>}</button>)}
        </div>
        <div id="scheduled-panel-plans" role="tabpanel" aria-labelledby="scheduled-tab-plans" hidden={tab !== "plans"} className="cms-scheduled-panel">
          <div className="cms-scheduled-heading"><div><h3>每日文案计划</h3><p>{plans.length} 条文案 · {enabledCount} 条已启用</p></div><button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => open()}><Plus size={15} />添加文案</button></div>
          {draft && <form ref={editor} className="cms-scheduled-card cms-scheduled-editor" onSubmit={save}>
            <fieldset disabled={Boolean(busy)}>
              <div className="cms-scheduled-heading"><h3>{draft.id ? "编辑文案计划" : "添加文案计划"}</h3><button type="button" className="cms-icon-button" aria-label="关闭文案编辑" onClick={() => { if (window.confirm("放弃当前未保存的草稿？")) setDraft(null); }}><X size={16} /></button></div>
              {conflict && <div className="cms-scheduled-conflict" role="alert"><span>{current ? "这条计划已有新版本，当前草稿尚未保存。" : "这条计划已被删除，草稿尚未保存。"}</span>{current && <button type="button" className="cms-secondary" onClick={() => { if (window.confirm("加载最新版本会替换当前未保存的草稿，继续？")) setDraft(draftOf(current)); }}>加载最新版本</button>}</div>}
              <label>后台名称<input required autoComplete="off" maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：每日欢迎文案" /><small>仅用于后台管理，不发送到频道。</small></label>
              <label>发送文案<textarea required rows={8} maxLength={4096} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} placeholder="输入要发送到三个频道的文案" /><small>{draft.text.length.toLocaleString()} / 4,096 · 保留文字、表情及换行，按纯文字发送。</small></label>
              <div className="cms-scheduled-time-fields"><div className="cms-scheduled-heading"><h3>每天发送时间（MYT）</h3><button type="button" className="cms-secondary" disabled={draft.times.length >= 24} onClick={() => setDraft({ ...draft, times: [...draft.times, ""] })}><Plus size={14} />添加时间</button></div>
                {draft.times.map((time, index) => <div className="cms-scheduled-time-input" key={index}><label>时间 {index + 1}<input type="time" step="60" required value={time} onChange={event => setDraft({ ...draft, times: draft.times.map((value, i) => i === index ? event.target.value : value) })} /></label><button type="button" className="cms-icon-button" disabled={draft.times.length === 1} aria-label={`移除时间 ${index + 1}`} onClick={() => setDraft({ ...draft, times: draft.times.filter((_, i) => i !== index) })}><Trash2 size={14} /></button></div>)}
                <small>每天自动按这些时间发送；一个时间点向三个频道各发送一次。</small>
              </div>
              <label className="cms-telegram-switch"><input type="checkbox" role="switch" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />保存后启用每日发送</label>
              {draft.enabled && !targetsReady && <small className="cms-scheduled-error">保存时会核实三个频道及机器人的发布权限；可先停用并保存文案。</small>}
              <div className="cms-scheduled-actions"><button className="cms-primary" type="submit" disabled={conflict}>{busy === "save" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}保存文案与时间</button><span className="cms-scheduled-muted">草稿需保存后才会生效</span></div>
            </fieldset>
          </form>}
          {!plans.length && !draft && <div className="cms-scheduled-empty"><strong>尚未添加文案计划</strong><p>添加一条文案，设置每日时间并启用，即可由后台自动发布。</p></div>}
          <div className="cms-scheduled-plan-list">{plans.map(plan => <article className="cms-scheduled-card" key={plan.id}>
            <div className="cms-scheduled-heading"><div><h3>{plan.name}</h3><span className={`cms-scheduled-pill ${plan.enabled ? "cms-scheduled-good" : ""}`}>{plan.enabled ? "每日发送已启用" : "已暂停"}</span></div><div className="cms-scheduled-actions"><button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => open(plan)}><Pencil size={14} />编辑</button><button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => void mutate(`toggle-${plan.id}`, "PUT", { ...draftOf(plan), enabled: !plan.enabled }, plan.enabled ? "每日计划已暂停。" : "每日计划已启用。")}>{plan.enabled ? <Pause size={14} /> : <Play size={14} />}{plan.enabled ? "暂停" : "启用"}</button><button type="button" className="cms-icon-button" aria-label={`删除计划 ${plan.name}`} disabled={Boolean(busy)} onClick={() => void remove(plan)}><Trash2 size={15} /></button></div></div>
            <p className="cms-scheduled-copy">{plan.text}</p><div className="cms-scheduled-plan-times">{plan.times.map(time => <span key={time}><Clock3 size={12} />{time}</span>)}</div><small className="cms-scheduled-muted">下次：{displayTime(plan.nextRunAt)} · 最近安排：{displayTime(plan.lastRunAt)}</small>
          </article>)}</div>
        </div>
        <div id="scheduled-panel-time" role="tabpanel" aria-labelledby="scheduled-tab-time" hidden={tab !== "time"} className="cms-scheduled-panel">
          <div className="cms-scheduled-card"><div className="cms-scheduled-heading"><div><h3>发送到三个频道</h3><p>使用已保存的 @FreeBonus365ChatBot，同一时段分别提交发布。</p></div><button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => void mutate("verify", "POST", { action: "verify" }, "频道权限检查已完成。")}>{busy === "verify" ? <LoaderCircle size={14} className="cms-spin" /> : <RefreshCw size={14} />}检查频道权限</button></div>
            {!status.hasToken && <p className="cms-scheduled-error">请先在上方 Telegram 设置保存聊天机器人的 Token。</p>}
            <div className="cms-scheduled-targets">{status.targets.map(target => <div key={target.key}><div><strong>{target.title}</strong><small>{target.chatId || "尚未连接"}</small></div><span className={`cms-scheduled-pill ${target.ready ? "cms-scheduled-good" : "cms-scheduled-attention"}`}>{target.ready ? "可发布" : "需要检查"}</span>{target.lastError && <p className="cms-scheduled-error">{target.lastError}</p>}</div>)}</div>
          </div>
          <div className="cms-scheduled-card"><div className="cms-scheduled-heading"><div><h3>接下来 24 小时</h3><p>按已保存的每日时间展示；每项安排发送到全部三个频道。</p></div></div>{timeline.length ? <ol className="cms-scheduled-timeline">{timeline.map(row => <li key={row.id}><time dateTime={new Date(row.at).toISOString()}>{displayTime(row.at)}</time><div><strong>{row.plan.name}</strong><small>{row.at <= now ? "已到时间，等待后台处理" : "每日自动发送"} · 3 个频道</small></div></li>)}</ol> : <div className="cms-scheduled-empty">没有已启用的发送安排。请在文案管理中添加或启用计划。</div>}</div>
          <div className="cms-scheduled-note"><p>保存后的计划由后台执行，关闭页面、刷新或正常重启不会重置每日时间。当天完成后自动安排下一天。</p><p>长时间停机错过的时段会跳过，避免恢复后集中补发。Telegram 未确认的发送会显示「待确认」，不会自动重发；请到发送记录核对。</p></div>
        </div>
        <div id="scheduled-panel-history" role="tabpanel" aria-labelledby="scheduled-tab-history" hidden={tab !== "history"} className="cms-scheduled-panel">
          <dl className="cms-scheduled-counts">{Object.entries(statusLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{status.counts[key] || 0}</dd></div>)}</dl>
          <div className="cms-scheduled-heading"><div><h3>逐频道发送记录</h3><p>同一次计划在三个频道的结果分开显示。</p></div><label className="cms-scheduled-filter">状态<select value={historyFilter} onChange={event => setHistoryFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
          {deliveries.length ? <div className="cms-scheduled-history">{deliveries.map(item => <article className="cms-scheduled-card" key={item.id}><div className="cms-scheduled-heading"><div><h3>{item.planName}</h3><p>{item.targetTitle}</p></div><span className={`cms-scheduled-pill ${item.status === "sent" ? "cms-scheduled-good" : item.status === "failed" || item.status === "unknown" ? "cms-scheduled-attention" : ""}`}>{statusLabels[item.status] || item.status}</span></div><small className="cms-scheduled-muted">计划：{displayTime(item.runAt)} · 发送：{displayTime(item.sentAt)}{item.messageId ? ` · 消息 #${item.messageId}` : ""}</small>{item.lastError && <p className="cms-scheduled-error">{item.lastError}</p>}</article>)}</div> : <div className="cms-scheduled-empty">暂无{historyFilter === "all" ? "" : statusLabels[historyFilter]}发送记录。</div>}
        </div>
      </>}
    </div>
  </section>;
}
