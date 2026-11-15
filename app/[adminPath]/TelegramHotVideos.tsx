"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CalendarClock, Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, Film, History, LoaderCircle,
  Pencil, Play, Radio, RefreshCw, Trash2, TriangleAlert, X } from "lucide-react";
import "./telegram-hot-videos-admin.css";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = { request: AdminRequest; signInPath: string };
type Tab = "sources" | "time" | "queue" | "history";
type Usage = "unused" | "pending" | "sending" | "sent" | "unknown" | "failed";
type HotVideo = { id: string; title: string; originalName: string; bytes: number; active: boolean; createdAt: number; lastSentAt: number | null;
  origin?: "channel" | "upload"; sourceChatId?: string; sourceMessageId?: number; sourceUrl?: string; used?: boolean; usageState?: Usage;
  sourceTitle?: string; sourceMarkerStatus?: string; sourceMarkerError?: string };
type SourceChannel = { chatId: string; title: string; selected: boolean; ready: boolean; lastError: string; lastSyncedAt: number | null; historyComplete?: boolean };
type SourceCandidate = { chatId: string; title: string; username?: string | null };
type HotJob = { id: string; videoId: string; title: string; kind: "manual" | "scheduled" | "automatic"; runAt: number;
  status: string; attempts?: number; lastError?: string; sentAt?: number | null; messageId?: number | null; markerStatus?: string; markerError?: string };
type Scheduler = { now: number; heartbeatAt: number | null; lastTickAt: number | null; lastCompletedAt?: number | null; workerHealthy: boolean;
  phase: string; scanPhase?: string; scanStartedAt?: number | null; lastScanAt?: number | null; nextRunAt: number | null;
  queuedCount: number; eligibleCount: number; unusedCount?: number; sourceCount?: number; blockedReason: string; nextJobs: HotJob[]; lastError?: string };
type HotStatus = { enabled: boolean; targetChatId: string; targetTitle: string; intervalHours: number; nextRunAt: number | null;
  revision: string; ready: boolean; lastError: string; lastCheckedAt: number | null; markSourceUsed?: boolean; scheduler?: Scheduler;
  sourceChannels?: SourceChannel[]; sourceCandidates?: SourceCandidate[]; videoCount?: number;
  videos: HotVideo[]; jobs: HotJob[]; counts: Record<string, number>; candidates?: { chatId: string; title: string }[] };
type SourceDraft = { targetChatId: string; sources: string[]; markSourceUsed: boolean; revision: string };
type RecurrenceDraft = { enabled: boolean; intervalHours: number; revision: string };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };
type AcceptMode = "source" | "recurrence" | "next" | "read" | "refresh";
type PlannedEntry = { key: string; runAt: number; title: string; kind: "manual" | "scheduled" | "automatic"; preview: boolean; status: string };

const endpoint = "/api/admin/telegram/hot-videos";
const HOUR = 3_600_000, DAY = 24 * HOUR;
const tabs = [
  { id: "sources", label: "来源频道", icon: Radio },
  { id: "time", label: "时间管理", icon: CalendarClock },
  { id: "queue", label: "视频队列", icon: Film },
  { id: "history", label: "发送记录", icon: History },
] as const;
const timezone = "Asia/Kuala_Lumpur";
const fullTime = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const briefTime = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hourTime = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, weekday: "short" });
const formatTime = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? fullTime.format(value) : "—";
const formatBrief = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? briefTime.format(value) : "—";
const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
const statusLabels: Record<string, string> = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", cancelled: "已取消", skipped: "已跳过" };
const markerLabels: Record<string, string> = { sent: "已标记来源", pending: "等待标记来源", sending: "正在标记来源", unknown: "来源标记待确认", failed: "来源标记失败", skipped: "未启用来源标记" };
const kindLabels = { manual: "立即发送", scheduled: "单次定时", automatic: "自动队列" } as const;
function dayKey(value: number): string {
  const parts = dayFormat.formatToParts(value), part = (kind: string) => parts.find(p => p.type === kind)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function dateInput(value: number) { return `${dayKey(value)}T${hourTime.format(value)}`; }
function dateValue(value: string): number | null { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? Date.parse(`${value}:00+08:00`) : null; }
function sourceDraft(value: HotStatus): SourceDraft {
  return { targetChatId: value.targetChatId || "", sources: (value.sourceChannels || []).filter(s => s.selected).map(s => s.chatId), markSourceUsed: value.markSourceUsed !== false, revision: value.revision };
}
function recurrenceDraft(value: HotStatus): RecurrenceDraft { return { enabled: value.enabled, intervalHours: value.intervalHours || 6, revision: value.revision }; }
function savedSettings(value: HotStatus) {
  return { enabled: value.enabled, targetChatId: value.targetChatId, intervalHours: value.intervalHours, firstRunAt: null as number | null,
    revision: value.revision, sources: sourceDraft(value).sources, markSourceUsed: value.markSourceUsed !== false };
}
function failed(error: unknown): Notice {
  return { message: error instanceof Error ? error.message : "暂时无法完成操作，请稍后重试。", error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401 };
}
function countdown(next: number | null, now: number): string {
  if (!next) return "尚未安排";
  const seconds = Math.max(0, Math.ceil((next - now) / 1000));
  if (!seconds) return "已到时间";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

export default function TelegramHotVideos({ request, signInPath }: Props) {
  const [status, setStatus] = useState<HotStatus | null>(null);
  const [source, setSource] = useState<SourceDraft>({ targetChatId: "", sources: [], markSourceUsed: true, revision: "" });
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>({ enabled: false, intervalHours: 6, revision: "" });
  const [firstRunAt, setFirstRunAt] = useState("");
  const [sourceDirty, setSourceDirty] = useState(false);
  const [recurrenceDirty, setRecurrenceDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("time");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reload, setReload] = useState(0);
  const [clientNow, setClientNow] = useState(() => Date.now());
  const [sourceSearch, setSourceSearch] = useState("");
  const [manualTarget, setManualTarget] = useState(false);
  const [videoFilter, setVideoFilter] = useState<"all" | "unused" | "used" | "attention">("unused");
  const [scheduledTimes, setScheduledTimes] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [calendarMode, setCalendarMode] = useState<"timeline" | "calendar">("timeline");
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState("");
  const sourceDirtyRef = useRef(false), recurrenceDirtyRef = useRef(false), busyRef = useRef("");
  const statusRef = useRef<HotStatus | null>(null), serverOffset = useRef(0), receivedAt = useRef(0), mutationEpoch = useRef(0);
  const firstRevision = useRef<string | null>(null), sendIds = useRef(new Map<string, string>()), rebaseOnRead = useRef(false);

  function accept(value: HotStatus, mode: AcceptMode = "read") {
    statusRef.current = value; setStatus(value); receivedAt.current = Date.now();
    if (typeof value.scheduler?.now === "number") serverOffset.current = value.scheduler.now - Date.now();
    if (mode === "source" || !sourceDirtyRef.current) setSource(sourceDraft(value));
    else if (mode !== "read") setSource(current => ({ ...current, revision: value.revision }));
    if (mode === "recurrence" || !recurrenceDirtyRef.current) setRecurrence(recurrenceDraft(value));
    else if (mode !== "read") setRecurrence(current => ({ ...current, revision: value.revision }));
    if (mode === "source") { sourceDirtyRef.current = false; setSourceDirty(false); }
    if (mode === "recurrence") { recurrenceDirtyRef.current = false; setRecurrenceDirty(false); }
    if (mode !== "read" && firstRevision.current) firstRevision.current = value.revision;
  }
  useEffect(() => {
    let active = true, polling = false;
    async function read(initial = false) {
      if (polling || busyRef.current || !initial && document.visibilityState === "hidden") return;
      const epoch = mutationEpoch.current; polling = true;
      if (initial) setLoading(true);
      try {
        const value = await request<HotStatus>(endpoint);
        if (active && epoch === mutationEpoch.current) { accept(value, rebaseOnRead.current ? "refresh" : "read"); rebaseOnRead.current = false; }
      }
      catch (error) { if (active) setNotice(failed(error)); }
      finally { polling = false; if (active && initial) setLoading(false); }
    }
    void read(true);
    const timer = setInterval(() => void read(), 10_000), visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [request, reload]);
  useEffect(() => { const timer = setInterval(() => setClientNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const now = clientNow + serverOffset.current;
  function changeSource(patch: Partial<SourceDraft>) { sourceDirtyRef.current = true; setSourceDirty(true); setNotice(null); setSource(current => ({ ...current, ...patch })); }
  function changeRecurrence(patch: Partial<RecurrenceDraft>) { recurrenceDirtyRef.current = true; setRecurrenceDirty(true); setNotice(null); setRecurrence(current => ({ ...current, ...patch })); }
  function changeFirst(value: string) {
    if (!value) firstRevision.current = null;
    else if (!firstRevision.current) firstRevision.current = statusRef.current?.revision || null;
    setFirstRunAt(value); setNotice(null);
  }
  function setWorking(value: string) { if (value) mutationEpoch.current++; busyRef.current = value; setBusy(value); }
  async function savePart(mode: "source" | "recurrence" | "next", event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const current = statusRef.current;
    if (!current || loading || busyRef.current) return;
    const body = savedSettings(current);
    if (mode === "source") {
      if (source.sources.includes(source.targetChatId.trim())) { setNotice({ message: "发布目标不能同时作为来源频道。", error: true }); return; }
      Object.assign(body, { targetChatId: source.targetChatId.trim(), sources: source.sources, markSourceUsed: source.markSourceUsed, revision: source.revision });
    } else if (mode === "recurrence") Object.assign(body, { enabled: recurrence.enabled, intervalHours: recurrence.intervalHours, revision: recurrence.revision });
    else {
      const runAt = dateValue(firstRunAt);
      if (!current.enabled) { setNotice({ message: "请先在固定间隔设置中启用并保存自动队列。", error: true }); return; }
      if (!runAt || runAt <= Date.now() + serverOffset.current) { setNotice({ message: "请选择晚于当前马来西亚时间的发送时间。", error: true }); return; }
      Object.assign(body, { firstRunAt: runAt, revision: firstRevision.current || current.revision });
    }
    setWorking(`save:${mode}`); setNotice(null);
    try {
      const value = await request<HotStatus>(endpoint, "PUT", body); accept(value, mode);
      if (mode === "next") { setFirstRunAt(""); firstRevision.current = null; }
      setNotice({ message: mode === "source" ? !value.enabled ? "来源与发布目标已保存，自动队列保持暂停。" : value.nextRunAt === current.nextRunAt ? "来源与发布目标已保存，现有发送时间保持不变。" : `来源与发布目标已保存，下一次发送：${formatTime(value.nextRunAt)}（MYT）。` : mode === "next" ? `下一次发送时间已保存：${formatTime(value.nextRunAt)}（MYT）。`
        : value.enabled ? `固定间隔已保存：每 ${value.intervalHours} 小时一条；下一次 ${formatTime(value.nextRunAt)}（MYT）。` : "自动队列已暂停，单次定时任务仍按原计划执行。" });
    } catch (error) { setNotice(failed(error)); }
    finally { setWorking(""); }
  }
  async function action(key: string, body: unknown, success: string): Promise<HotStatus | null> {
    if (busyRef.current) return null;
    setWorking(key); setNotice(null);
    try { const value = await request<HotStatus>(endpoint, "POST", body); accept(value); setNotice({ message: success }); return value; }
    catch (error) { setNotice(failed(error)); return null; }
    finally { setWorking(""); }
  }
  async function syncSources() {
    const value = await action("sync_sources", { action: "sync_sources" }, "来源检查请求已保存，系统将继续收集频道视频；不会立即群发。");
    if (value?.sourceChannels?.some(channel => channel.lastError)) setNotice({ message: "来源检查发现问题，请查看下方对应频道的说明。", error: true });
  }
  async function send(video: HotVideo, scheduled: boolean) {
    if (sourceDirtyRef.current) { setNotice({ message: "来源或目标有未保存的修改，请先保存来源设置。", error: true }); setActiveTab("sources"); return; }
    const runAt = scheduled ? dateValue(scheduledTimes[video.id] || "") : null;
    if (scheduled && (!runAt || runAt <= Date.now() + serverOffset.current)) { setNotice({ message: "请选择晚于当前马来西亚时间的发送时间。", error: true }); return; }
    const key = `${video.id}:${runAt ?? "now"}`, requestId = sendIds.current.get(key) || crypto.randomUUID(); sendIds.current.set(key, requestId);
    const value = await action(`send:${video.id}`, { action: "send", videoId: video.id, runAt, requestId }, scheduled ? `单次任务已保存：${formatTime(runAt)}（MYT）。` : "已进入立即发送队列，结果请查看发送记录。");
    if (value) { sendIds.current.delete(key); if (scheduled) setScheduledTimes(current => ({ ...current, [video.id]: "" })); }
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!renaming?.title.trim()) return;
    if (await action(`rename:${renaming.id}`, { action: "update", id: renaming.id, title: renaming.title.trim() }, "视频名称已保存。")) setRenaming(null);
  }
  function usage(video: HotVideo): string {
    if (video.lastSentAt || video.usageState === "sent") return "used";
    if (video.usageState && ["unknown", "sending", "pending", "failed"].includes(video.usageState)) return video.usageState;
    return status?.jobs.find(job => job.videoId === video.id && ["unknown", "sending", "pending"].includes(job.status))?.status || (video.used ? "unknown" : "unused");
  }
  function toggleSource(chatId: string, selected: boolean) { changeSource({ sources: selected ? [...new Set([...source.sources, chatId])] : source.sources.filter(id => id !== chatId) }); }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.findIndex(tab => tab.id === activeTab); let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0; else if (event.key === "End") next = tabs.length - 1; else return;
    event.preventDefault(); setActiveTab(tabs[next].id); document.getElementById(`cms-hot-tab-${tabs[next].id}`)?.focus();
  }
  const scheduler = status?.scheduler, eligible = scheduler?.eligibleCount, pendingCount = scheduler?.queuedCount ?? status?.counts.pending ?? 0;
  const savedSources = status?.sourceChannels?.filter(channel => channel.selected) || [];
  const sourceChoices = new Map<string, SourceCandidate>((status?.sourceCandidates || []).map(candidate => [candidate.chatId, candidate]));
  for (const channel of savedSources) if (!sourceChoices.has(channel.chatId)) sourceChoices.set(channel.chatId, channel);
  const matchingSources = [...sourceChoices.values()].filter(channel => `${channel.title} ${channel.username || ""} ${channel.chatId}`.toLowerCase().includes(sourceSearch.trim().toLowerCase()));
  const targets = new Map((status?.candidates || []).map(candidate => [candidate.chatId, candidate]));
  if (status?.targetChatId && !targets.has(status.targetChatId)) targets.set(status.targetChatId, { chatId: status.targetChatId, title: status.targetTitle || "🔞365 Free Bonus Hot" });
  const useManualTarget = manualTarget || !targets.size || !!source.targetChatId && !targets.has(source.targetChatId);
  const nextRunAt = scheduler?.nextRunAt ?? status?.nextRunAt ?? null;
  const staleStatus = !!status && receivedAt.current > 0 && clientNow - receivedAt.current > 45_000;
  const blockedReason = scheduler?.blockedReason || (status?.enabled && eligible === 0 ? savedSources.length ? "目前没有可自动发送的视频。请检查来源同步与视频状态。" : "尚未保存来源频道，请先完成来源设置。" : "");
  const phaseLabels: Record<string, string> = { checking: "正在检查发送条件", sending: "正在发送一条视频", marker: "正在标记已使用的视频", idle: "等待下一次发送" };
  const statusText = loading && !status ? "读取中" : staleStatus ? "等待刷新状态" : !status?.enabled ? "自动队列已暂停"
    : !scheduler ? "等待调度检查" : !scheduler.workerHealthy ? "调度服务需要检查" : blockedReason ? "计划已保存，等待处理" : phaseLabels[scheduler.phase] || "等待下一次发送";
  const statusTone = !status?.enabled || staleStatus ? "neutral" : scheduler?.workerHealthy && !blockedReason ? "ready" : blockedReason || scheduler && !scheduler.workerHealthy ? "warning" : "neutral";
  const visibleVideos = (status?.videos || []).filter(video => {
    const state = usage(video);
    if (videoFilter === "all") return true;
    if (videoFilter === "used") return state === "used";
    return videoFilter === "attention" ? ["unknown", "failed"].includes(state) : state !== "used";
  });
  const savedJobMap = new Map<string, HotJob>();
  for (const job of [...(scheduler?.nextJobs || []), ...(status?.jobs || [])]) if (job.status === "pending") savedJobMap.set(job.id, job);
  const savedJobs = [...savedJobMap.values()].sort((a, b) => a.runAt - b.runAt || a.id.localeCompare(b.id));
  const jobsTruncated = pendingCount > savedJobs.length;
  const planned = (count: number): PlannedEntry[] => {
    const actual: PlannedEntry[] = savedJobs.map(job => ({ key: job.id, runAt: job.runAt, title: job.title || "已安排的视频", kind: job.kind, preview: false, status: job.status }));
    if (status?.enabled && nextRunAt && status.intervalHours > 0) for (let index = 0; index < count; index++) {
      const runAt = nextRunAt + index * status.intervalHours * HOUR;
      if (!actual.some(entry => entry.kind === "automatic" && entry.runAt === runAt)) actual.push({ key: `preview:${runAt}`, runAt, title: "从未使用队列取一条视频", kind: "automatic", preview: true, status: "preview" });
    }
    return actual.sort((a, b) => a.runAt - b.runAt || a.key.localeCompare(b.key));
  };
  const upcoming = planned(6).slice(0, 10);
  const today = dayKey(now), weekStart = Date.parse(`${today}T00:00:00+08:00`) + weekOffset * 7 * DAY;
  const calendarDays = Array.from({ length: 7 }, (_, index) => weekStart + index * DAY);
  const calendarPreviewCount = nextRunAt ? Math.max(0, Math.ceil((weekStart + 7 * DAY - nextRunAt) / (Math.max(1, status?.intervalHours || 6) * HOUR))) : 0;
  const calendarEntries = planned(Math.min(1500, calendarPreviewCount)).filter(entry => entry.runAt >= weekStart && entry.runAt < weekStart + 7 * DAY);
  const activeDay = calendarDays.some(day => dayKey(day) === selectedDay) ? selectedDay : dayKey(calendarDays[0]);
  const dayEntries = calendarEntries.filter(entry => dayKey(entry.runAt) === activeDay);
  const disabled = loading || !!busy;
  const automaticPhase = status?.enabled && nextRunAt && nextRunAt <= now ? scheduler?.phase === "sending" ? "正在发送" : "正在等待同步/处理" : "";
  const marker = (state?: string, error?: string) => state && state !== "none" ? <small className={error || ["failed", "unknown"].includes(state) ? "cms-hot-error-text" : "cms-hot-muted"}>{markerLabels[state] || state}{error ? ` · ${error}` : ""}</small> : null;
  const timelineRows = (entries: PlannedEntry[]) => entries.length ? <ol className="cms-hot-timeline">{entries.map(entry => <li key={entry.key} className={entry.preview ? "cms-hot-plan-preview" : ""}>
    <time dateTime={new Date(entry.runAt).toISOString()}><strong>{hourTime.format(entry.runAt)}</strong><span>{dayKey(entry.runAt).slice(5).replace("-", "/")}</span></time>
    <div><strong>{entry.title}</strong><small>{entry.preview ? "自动间隔计划 · 到时取队列中一条未使用视频" : `${kindLabels[entry.kind]} · 任务已保存`}</small></div>
    <span className={`cms-hot-pill ${entry.preview ? "cms-hot-pill-neutral" : "cms-hot-pill-ready"}`}>{entry.preview ? "计划预览" : "已安排"}</span>
  </li>)}</ol> : <p className="cms-hot-empty">这个时间范围内还没有已安排的发送时间。</p>;

  return <section className="cms-settings-form cms-telegram-settings cms-hot-videos cms-hot-workspace" aria-labelledby="hot-videos-title">
    <div className="cms-settings-panel">
      <header className="cms-hot-header"><div><h2 id="hot-videos-title">Hot 视频管理</h2><p>来源收集、发送时间与使用记录分开管理。发布时不带文案，保留既定的三个链接按钮。</p></div>
        <div className="cms-hot-header-actions"><span className={`cms-hot-pill cms-hot-pill-${statusTone}`}>{statusText}</span>
          <button className="cms-secondary" type="button" disabled={disabled} onClick={() => { rebaseOnRead.current = true; setReload(value => value + 1); }} aria-label="刷新 Hot 视频管理并保留草稿"><RefreshCw size={14} />刷新</button></div></header>
      {notice && <div className={`cms-alert${notice.error ? " cms-error" : " cms-success"}`} role={notice.error ? "alert" : "status"}><span>{notice.message}</span>
        {notice.sessionExpired && <a href={signInPath} target="_top" className="cms-reauth">重新登入 ↗</a>}</div>}
      <nav className="cms-hot-tabs" role="tablist" aria-label="Hot 视频管理页面">{tabs.map(tab => { const Icon = tab.icon; return <button key={tab.id} id={`cms-hot-tab-${tab.id}`} type="button" role="tab"
        aria-selected={activeTab === tab.id} aria-controls={`cms-hot-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onKeyDown={tabKeys} onClick={() => setActiveTab(tab.id)}>
        <Icon size={16} />{tab.label}{tab.id === "sources" && !savedSources.length && <span className="cms-hot-tab-dot" aria-label="需要设置来源" />}
        {tab.id === "queue" && <small>{status?.videoCount ?? status?.videos.length ?? 0}</small>}</button>; })}</nav>

      <section className="cms-hot-panel" id="cms-hot-panel-sources" role="tabpanel" aria-labelledby="cms-hot-tab-sources" hidden={activeTab !== "sources"}>
        <div className="cms-hot-section-heading"><div><h3>来源与发布目标</h3><p>先保存来源，再检查频道。识别到的视频进入队列，不会一次发完。</p></div>
          <button className="cms-secondary" type="button" disabled={disabled || sourceDirty || !savedSources.length} onClick={() => void syncSources()}>{busy === "sync_sources" ? <LoaderCircle size={14} className="cms-spin" /> : <RefreshCw size={14} />}检查来源视频</button></div>
        <form className="cms-hot-card" onSubmit={event => void savePart("source", event)}><fieldset disabled={disabled}>
          <label>发布目标{targets.size > 0 && <select value={useManualTarget ? "manual" : source.targetChatId} onChange={event => {
            if (event.target.value === "manual") setManualTarget(true); else { setManualTarget(false); changeSource({ targetChatId: event.target.value }); }
          }}><option value="">选择目标频道</option>{[...targets.values()].map(candidate => <option key={candidate.chatId} value={candidate.chatId}>{candidate.title || candidate.chatId}</option>)}<option value="manual">手动填写频道 ID</option></select>}
            {useManualTarget && <input value={source.targetChatId} maxLength={80} spellCheck={false} autoComplete="off" placeholder="例如：-1001234567890" onChange={event => changeSource({ targetChatId: event.target.value })} />}</label>
          <div className="cms-hot-source-heading"><strong>选择来源频道 <span>{source.sources.length} / 20</span></strong><span className="cms-hot-muted">已保存 {savedSources.length} 个来源</span></div>
          {sourceChoices.size > 6 && <label className="cms-hot-source-search">查找来源<input type="search" value={sourceSearch} placeholder="频道名称、用户名或 ID" onChange={event => setSourceSearch(event.target.value)} /></label>}
          {matchingSources.length ? <div className="cms-hot-source-options">{matchingSources.map(channel => <label key={channel.chatId} className="cms-hot-source-option">
            <input type="checkbox" checked={source.sources.includes(channel.chatId)} disabled={!source.sources.includes(channel.chatId) && (channel.chatId === source.targetChatId.trim() || source.sources.length >= 20)} onChange={event => toggleSource(channel.chatId, event.target.checked)} />
            <span><strong>{channel.title || channel.chatId}</strong><small>{channel.username ? `@${channel.username} · ` : ""}{channel.chatId}</small></span></label>)}</div>
            : <p className="cms-hot-empty">{sourceSearch ? "没有匹配的来源频道。" : "请先连接个人 Telegram 账号并加入来源频道，再刷新频道列表。"}</p>}
          <label className="cms-telegram-switch"><input type="checkbox" checked={source.markSourceUsed} onChange={event => changeSource({ markSourceUsed: event.target.checked })} />发送成功后，由 ChatBot 在来源视频下标记“✅ Sent · Used”</label>
          <small>只收集可播放的 MP4 视频，来源频道不能限制转发。@FreeBonus365ChatBot 需有目标频道发布权限；标记来源还需要来源频道发布权限。</small>
          <div className="cms-hot-form-footer"><span className={sourceDirty ? "cms-hot-unsaved" : "cms-hot-muted"}>{sourceDirty ? "有未保存的来源或目标修改" : "来源设置已保存"}</span>
            <button className="cms-primary" type="submit" disabled={!sourceDirty}>{busy === "save:source" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}保存来源设置</button></div>
        </fieldset></form>
        <div className="cms-hot-source-health"><div className="cms-hot-section-heading"><h3>来源检查状态</h3><small>最近检查：{formatTime(scheduler?.lastScanAt)}</small></div>
          {!savedSources.length ? <p className="cms-hot-empty">尚未保存来源频道。</p> : savedSources.map(channel => <article key={channel.chatId} className="cms-hot-card">
            <div className="cms-hot-section-heading"><strong>{channel.title || channel.chatId}</strong><span className={`cms-hot-pill cms-hot-pill-${channel.lastError ? "warning" : channel.ready ? "ready" : "neutral"}`}>{channel.lastError ? "需要处理" : channel.ready ? "来源已连接" : "等待检查"}</span></div>
            <small>最近同步：{formatTime(channel.lastSyncedAt)}{channel.historyComplete === false ? " · 正在继续读取历史视频" : channel.historyComplete ? " · 历史已检查，持续收集新视频" : ""}</small>
            {channel.lastError && <p className="cms-hot-error-text" role="alert">{channel.lastError}</p>}</article>)}
        </div>
      </section>

      <section className="cms-hot-panel" id="cms-hot-panel-time" role="tabpanel" aria-labelledby="cms-hot-tab-time" hidden={activeTab !== "time"}>
        <div className="cms-hot-time-overview"><div className="cms-hot-now"><Clock3 size={16} /><div><small>服务器当前时间 · 马来西亚（UTC+8）</small><strong>{scheduler ? formatTime(now) : "读取服务器时间…"}</strong></div></div>
          <div className={`cms-hot-next${status?.enabled && (blockedReason || scheduler && !scheduler.workerHealthy) ? " cms-hot-next-blocked" : !status?.enabled ? " cms-hot-next-paused" : ""}`}><small>下一次自动发送 · 已保存</small><strong>{status?.enabled ? formatTime(nextRunAt) : "自动队列已暂停"}</strong><span>{status?.enabled ? nextRunAt ? automaticPhase ? `已到时间 · ${automaticPhase}` : `${blockedReason || scheduler && !scheduler.workerHealthy ? "距计划检查" : "距离发送"} ${countdown(nextRunAt, now)}` : "尚未安排下一次时间" : "启用并保存固定间隔后安排下一次发送"}</span></div></div>
        <div className="cms-hot-metrics"><div><small>可自动发送</small><strong>{eligible ?? "—"}<span> 条</span></strong></div><div><small>已保存的待发送任务</small><strong>{pendingCount}<span> 条</span></strong></div>
          <div><small>最近调度检查</small><strong className="cms-hot-metric-time">{formatBrief(scheduler?.lastTickAt)}</strong><span>{scheduler ? scheduler.workerHealthy ? "后台运行正常" : "后台需要检查" : "等待状态"}</span></div></div>
        {status?.enabled && blockedReason && <div className="cms-hot-blocked" role="alert"><TriangleAlert size={18} /><div><strong>{eligible === 0 ? "还没有可自动发送的视频" : "发送条件需要处理"}</strong><p>{blockedReason}</p>
          <button type="button" className="cms-secondary" onClick={() => setActiveTab("sources")}>查看来源频道</button></div></div>}
        {status?.enabled && !scheduler?.workerHealthy && scheduler && <p className="cms-hot-error-text" role="alert">暂未确认调度服务正在正常运行。最近检查：{formatTime(scheduler.heartbeatAt)}。请刷新查看最新状态。</p>}
        <div className="cms-hot-schedule-forms"><form className="cms-hot-card" onSubmit={event => void savePart("recurrence", event)}><fieldset disabled={disabled}>
          <div className="cms-hot-section-heading"><h3>固定间隔</h3><span className={recurrenceDirty ? "cms-hot-unsaved" : "cms-hot-saved"}>{recurrenceDirty ? "有未保存修改" : "已保存"}</span></div>
          <p className="cms-hot-saved-summary">当前已保存：{status?.enabled ? `每 ${status.intervalHours} 小时发送一条` : "自动队列暂停"}</p>
          <label className="cms-telegram-switch"><input type="checkbox" checked={recurrence.enabled} onChange={event => changeRecurrence({ enabled: event.target.checked })} />启用自动队列</label>
          <label>发送间隔<select value={recurrence.intervalHours} onChange={event => changeRecurrence({ intervalHours: Number(event.target.value) })}>
            {[...new Set([1, 3, 6, 12, 24, recurrence.intervalHours])].sort((a, b) => a - b).map(hours => <option key={hours} value={hours}>每 {hours} 小时一条{hours === 6 ? "（每天 4 条）" : ""}</option>)}</select></label>
          <small>更改后需点击保存。间隔未改变时保留原有下一次时间；改变间隔后按新间隔重新安排。</small>
          <button type="submit" className="cms-primary" disabled={!recurrenceDirty}>{busy === "save:recurrence" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}保存间隔设置</button>
        </fieldset></form>
          <form className="cms-hot-card" onSubmit={event => void savePart("next", event)}><fieldset disabled={disabled}>
            <div className="cms-hot-section-heading"><h3>指定下一次发送时间</h3>{firstRunAt && <span className="cms-hot-unsaved">尚未保存</span>}</div>
            <p className="cms-hot-saved-summary">当前时间：{status?.enabled ? formatBrief(nextRunAt) : "先启用并保存自动队列"}</p>
            <label>下一次时间（MYT）<input type="datetime-local" step="60" min={dateInput(now)} value={firstRunAt} onChange={event => changeFirst(event.target.value)} /></label>
            <small>{firstRunAt ? "此时间尚未生效。保存后从这个时间开始，继续按已保存的固定间隔逐条发送。" : "留空保持现有计划。这里单独保存，不会应用未保存的来源或间隔修改。"}</small>
            <button type="submit" className="cms-primary" disabled={!firstRunAt || !status?.enabled}>{busy === "save:next" ? <LoaderCircle size={15} className="cms-spin" /> : <CalendarClock size={15} />}保存下次时间</button>
          </fieldset></form></div>
        <div className="cms-hot-card cms-hot-plan"><div className="cms-hot-section-heading"><div><h3>已保存的发送计划</h3><small>自动计划每次只取一条未使用视频；实际发送结果记录在“发送记录”。</small></div>
          <div className="cms-hot-segment" role="group" aria-label="发送计划显示方式"><button type="button" aria-pressed={calendarMode === "timeline"} onClick={() => setCalendarMode("timeline")}>时间线</button><button type="button" aria-pressed={calendarMode === "calendar"} onClick={() => setCalendarMode("calendar")}>7 天日历</button></div></div>
          {jobsTruncated && <small className="cms-hot-unsaved">已载入 {savedJobs.length} 个待发送任务 / 共 {pendingCount} 个。下方仅展示已载入任务，完整计划仍保存在后台。</small>}
          {calendarMode === "timeline" ? timelineRows(upcoming) : <><div className="cms-hot-calendar-toolbar"><button className="cms-icon-button" type="button" aria-label="上一周" disabled={weekOffset === 0} onClick={() => setWeekOffset(value => Math.max(0, value - 1))}><ChevronLeft size={15} /></button>
            <strong>{dayKey(calendarDays[0])} — {dayKey(calendarDays[6])}</strong><button className="cms-icon-button" type="button" aria-label="下一周" disabled={weekOffset >= 7} onClick={() => setWeekOffset(value => value + 1)}><ChevronRight size={15} /></button></div>
            <div className="cms-hot-calendar-days">{calendarDays.map(day => { const key = dayKey(day), count = calendarEntries.filter(entry => dayKey(entry.runAt) === key).length; return <button type="button" key={key} aria-pressed={activeDay === key} onClick={() => setSelectedDay(key)}>
              <small>{weekdayFormat.format(day)}</small><strong>{key.slice(5).replace("-", "/")}</strong><span>{count ? `${count} 个时段` : jobsTruncated ? "待载入" : "暂无安排"}</span></button>; })}</div>
            <div className="cms-hot-section-heading"><strong>{activeDay} 的安排</strong><button className="cms-secondary" type="button" disabled={disabled || !status?.enabled} onClick={() => changeFirst(`${activeDay}T${hourTime.format(nextRunAt || now + HOUR)}`)}>在此日期设置下次时间</button></div>
            {timelineRows(dayEntries)}</>}
          <small>“计划预览”尚未绑定视频；到时没有可发送视频会等待或跳过，不会把积压视频集中补发。单次定时任务独立于固定间隔。</small>
        </div>
      </section>

      <section className="cms-hot-panel" id="cms-hot-panel-queue" role="tabpanel" aria-labelledby="cms-hot-tab-queue" hidden={activeTab !== "queue"}>
        <div className="cms-hot-section-heading"><div><h3>视频队列 <span>{status?.videoCount ?? status?.videos.length ?? 0}</span></h3><p>每条视频保留来源和使用状态。单次时间需单独保存。</p></div>
          <button className="cms-secondary" type="button" disabled={disabled || sourceDirty || !savedSources.length} onClick={() => void syncSources()}><RefreshCw size={14} />检查新视频</button></div>
        <div className="cms-hot-segment" role="group" aria-label="视频状态筛选">{([["unused", "未使用"], ["used", "已使用"], ["attention", "需要处理"], ["all", "全部"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={videoFilter === value} onClick={() => setVideoFilter(value)}>{label}</button>)}</div>
        {status && (status.videoCount || 0) > status.videos.length && <small className="cms-hot-muted">已载入 {status.videos.length} 条 / 共 {status.videoCount} 条；筛选只针对已载入的视频，完整队列保留在后台。</small>}
        {!status?.videos.length ? <div className="cms-hot-empty"><Film size={22} /><strong>还没有视频进入后台队列</strong><p>{blockedReason || "请到来源频道页面保存来源，并检查频道视频。"}</p><button className="cms-secondary" type="button" onClick={() => setActiveTab("sources")}>查看来源与检查状态</button></div>
          : !visibleVideos.length ? <p className="cms-hot-empty">当前已载入的视频中，没有符合这个状态的视频。</p>
          : <div className="cms-hot-video-grid">{visibleVideos.map(video => {
            const state = usage(video), retryable = ["unused", "failed"].includes(state), pending = savedJobs.find(job => job.videoId === video.id)
              || status.jobs.find(job => job.videoId === video.id && ["sending", "unknown"].includes(job.status));
            const title = video.title || video.originalName || "视频";
            return <article className="cms-hot-card cms-hot-video-card" key={video.id}>
              <div className="cms-hot-section-heading"><div><strong>{title}</strong><small>{video.sourceTitle || (video.origin === "upload" ? "原有上传视频" : "来源频道视频")} · {formatSize(video.bytes)}</small></div>
                <div className="cms-hot-inline-actions"><button className="cms-icon-button" type="button" disabled={disabled} aria-label={`重命名 ${title}`} onClick={() => setRenaming({ id: video.id, title: video.title })}><Pencil size={14} /></button>
                  <button className="cms-icon-button" type="button" disabled={disabled || state === "sending"} aria-label={`从队列移除 ${title}`} onClick={() => void action(`delete:${video.id}`, { action: "delete", id: video.id }, "已从后台队列移除，对应待发送任务已取消。来源频道中的原视频不会被删除。" )}><Trash2 size={14} /></button></div></div>
              <span className={`cms-hot-pill cms-hot-pill-${state === "used" ? "ready" : ["unknown", "failed"].includes(state) ? "warning" : "neutral"}`}>{state === "used" ? "✅ 已发送 · 已使用" : state === "unused" ? "未使用" : state === "failed" ? "发送失败，可检查后重试" : statusLabels[state]}</span>
              {video.sourceUrl && <a className="cms-hot-source-link" href={video.sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} />打开来源视频{video.sourceMessageId ? ` #${video.sourceMessageId}` : ""}</a>}
              {renaming?.id === video.id && <form className="cms-hot-rename" onSubmit={rename}><input required maxLength={120} aria-label="新视频名称" value={renaming.title} onChange={event => setRenaming({ id: video.id, title: event.target.value })} disabled={disabled} /><button className="cms-secondary" type="submit" disabled={disabled}>保存</button><button className="cms-icon-button" type="button" aria-label="取消重命名" onClick={() => setRenaming(null)}><X size={14} /></button></form>}
              {video.lastSentAt && <small className="cms-hot-muted">发送时间：{formatTime(video.lastSentAt)}</small>}{marker(video.sourceMarkerStatus, video.sourceMarkerError)}
              {pending && <div className={`cms-hot-task-saved${pending.status === "unknown" ? " cms-hot-task-uncertain" : ""}`}><strong>{pending.status === "pending" ? `${kindLabels[pending.kind]}任务已保存` : statusLabels[pending.status]}</strong><span>{formatTime(pending.runAt)}（MYT）</span>
                {pending.status === "pending" && <button className="cms-secondary" type="button" disabled={disabled} onClick={() => void action(`cancel:${pending.id}`, { action: "cancel", id: pending.id }, `${kindLabels[pending.kind]}任务已取消，固定间隔保持不变。`)}>取消此任务</button>}
                {pending.status === "unknown" && <small>发送结果未确认，系统不会自动重发。</small>}</div>}
              {video.origin === "channel" && <label className="cms-telegram-switch"><input type="checkbox" checked={video.active && state === "unused"} disabled={disabled || state !== "unused"}
                onChange={event => void action(`active:${video.id}`, { action: "update", id: video.id, active: event.target.checked }, event.target.checked ? "视频已加入自动队列。" : "视频已退出自动队列，单次发送仍可安排。")} />{state === "used" ? "已使用，自动跳过" : state === "failed" ? "自动已跳过，检查后可手动重试" : state === "unknown" ? "结果待确认，自动暂停此视频" : ["pending", "sending"].includes(state) ? "已有发送任务，自动跳过" : "加入固定间隔队列"}</label>}
              {retryable && <div className="cms-hot-video-schedule"><button className="cms-secondary" type="button" disabled={disabled || !status.targetChatId || sourceDirty} onClick={() => void send(video, false)}><Play size={14} />立即发送</button>
                <label>单次发送时间（MYT）<input type="datetime-local" step="60" min={dateInput(now)} value={scheduledTimes[video.id] || ""} disabled={disabled} onChange={event => setScheduledTimes(current => ({ ...current, [video.id]: event.target.value }))} /></label>
                <div className="cms-hot-form-footer"><small className={scheduledTimes[video.id] ? "cms-hot-unsaved" : "cms-hot-muted"}>{scheduledTimes[video.id] ? "时间尚未保存" : "按固定间隔发送，或单独指定时间"}</small>
                  <button className="cms-primary" type="button" disabled={disabled || !scheduledTimes[video.id] || !status.targetChatId || sourceDirty} onClick={() => void send(video, true)}><CalendarClock size={14} />保存单次时间</button></div></div>}
            </article>;
          })}</div>}
      </section>

      <section className="cms-hot-panel" id="cms-hot-panel-history" role="tabpanel" aria-labelledby="cms-hot-tab-history" hidden={activeTab !== "history"}>
        <div className="cms-hot-section-heading"><div><h3>发送记录</h3><p>发布目标：{status?.targetTitle || "🔞365 Free Bonus Hot"}</p></div><span className="cms-hot-muted">所有时间均为 MYT</span></div>
        <dl className="cms-hot-history-counts">{Object.entries(status?.counts || {}).map(([key, count]) => <div key={key}><dt>{statusLabels[key] || key}</dt><dd>{count}</dd></div>)}</dl>
        {status && Object.values(status.counts).reduce((total, count) => total + count, 0) > status.jobs.length && <small className="cms-hot-muted">显示最近 {status.jobs.length} 条发送记录；上方统计包含全部历史任务。</small>}
        {status?.lastError && <p className="cms-hot-error-text" role="alert">{status.lastError}</p>}
        {!status?.jobs.length ? <p className="cms-hot-empty">还没有发送任务。保存单次时间或自动任务到时后，记录会显示在这里。</p> : <ol className="cms-hot-job-list">{status.jobs.map(job => <li key={job.id}>
          <div><strong>{job.title || "视频"}</strong><small>{kindLabels[job.kind]} · {formatTime(job.sentAt || job.runAt)}（MYT）</small>{job.lastError && <p className="cms-hot-error-text">{job.lastError}</p>}{marker(job.markerStatus, job.markerError)}</div>
          <span className={`cms-hot-pill cms-hot-pill-${job.status === "sent" ? "ready" : ["unknown", "failed"].includes(job.status) ? "warning" : "neutral"}`}>{statusLabels[job.status] || job.status}</span>
          {job.status === "pending" && <button className="cms-secondary" type="button" disabled={disabled} onClick={() => void action(`cancel:${job.id}`, { action: "cancel", id: job.id }, "发送任务已取消，固定间隔保持不变。")}>取消任务</button>}</li>)}</ol>}
        <small className="cms-hot-muted">只有 Telegram 确认发布成功，才显示“已发送 · 已使用”。待确认任务不会自动重发；来源标记失败也不会重发目标视频。</small>
      </section>
    </div>
  </section>;
}
