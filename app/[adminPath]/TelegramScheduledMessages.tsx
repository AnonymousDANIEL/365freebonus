"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Check, Clock3, Gamepad2, History, Images, LoaderCircle, MessageSquareText, Paperclip, Pause, Pencil, Play, Plus, Radio, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { DEFAULT_GAME_TIPS_CAPTION_PRESET_ID, GAME_TIPS_CAPTION_BODIES, GAME_TIPS_CAPTION_PRESETS, gameTipsCaption } from "../lib/telegram-game-tips-captions";
import { gameTipsProviderKey, type GameTipsProvider } from "../lib/telegram-game-tips-types";
import type { ScheduledMessagePlan, ScheduledMessagePlanInput, ScheduledMessageStatus, ScheduledMessageTarget, ScheduledMessageTargetKey } from "../lib/telegram-scheduled-messages-types";
import TelegramGameTipsLibrary from "./TelegramGameTipsLibrary";
import "./telegram-scheduled-messages-admin.css";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = { request: Request; signInPath: string; workspace?: "messages" | "gameTips" };
type Notice = { message: string; error?: boolean; expired?: boolean };
type Tab = "plans" | "library" | "channels" | "time" | "history";
type Attachment = NonNullable<ScheduledMessagePlan["media"]>;
type UploadResponse = Attachment | { id: string; received: number };
type PlanDraft = Omit<ScheduledMessagePlanInput, "mediaId" | "gameTipsProvider"> & {
  calendarDate: string; repeatDaily: boolean; targetKeys: ScheduledMessageTargetKey[]; media: Attachment | null; gameTipsProvider?: string;
};
type ChannelDraft = { requestId?: string; key?: ScheduledMessageTargetKey; revision?: string; title: string; address: string };
const endpoint = "/api/admin/telegram/scheduled-messages";
const uploadEndpoint = `${endpoint}/upload`;
const timezone = "Asia/Kuala_Lumpur";
const dayMs = 86_400_000;
const chunkBytes = 4 * 1024 * 1024;
const hourMinute = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
const statusLabels: Record<string, string> = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", cancelled: "已取消", skipped: "已跳过" };
const commonTabs = [
  { id: "channels", label: "频道管理", icon: Radio },
  { id: "time", label: "发送排期", icon: CalendarClock },
  { id: "history", label: "发送记录", icon: History },
] as const;
const messageTabs = [{ id: "plans", label: "文案管理", icon: MessageSquareText }, ...commonTabs] as const;
const gameTipsTabs = [
  { id: "library", label: "游戏平台图库", icon: Images },
  { id: "plans", label: "排期管理", icon: Gamepad2 },
  ...commonTabs,
] as const;
const mediaLabels = { photo: "照片", video: "视频", animation: "GIF" };
const mediaLimits: Record<string, number> = { "image/jpeg": 10, "image/png": 10, "image/gif": 20, "video/mp4": 50 };
const mediaExtensions: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", mp4: "video/mp4" };
const displayTime = (value: number | null | undefined) => value ? timeFormat.format(value) : "—";
function freshDraft(today: string): PlanDraft {
  return { requestId: crypto.randomUUID(), name: "", text: "", times: [""], enabled: false, calendarDate: today, repeatDaily: false, targetKeys: [], media: null };
}
function draftOf(plan: ScheduledMessagePlan, today: string, defaults: ScheduledMessageTargetKey[]): PlanDraft {
  return {
    id: plan.id, revision: plan.revision, name: plan.name, text: plan.text, times: [...plan.times], enabled: plan.enabled,
    calendarDate: plan.calendarDate || today, repeatDaily: !plan.calendarDate,
    targetKeys: [...(plan.targetKeys ?? defaults)], media: plan.media ?? null,
    ...(plan.gameTipsProvider ? { gameTipsProvider: plan.gameTipsProvider,
      gameTipsCaptionPresetId: plan.gameTipsCaptionPresetId || DEFAULT_GAME_TIPS_CAPTION_PRESET_ID } : {}),
  };
}
function payloadOf({ media, repeatDaily, ...draft }: PlanDraft): ScheduledMessagePlanInput {
  return { ...draft, name: draft.name.trim(), times: [...draft.times].sort(), calendarDate: repeatDaily ? "" : draft.calendarDate, mediaId: media?.id ?? null };
}
function describeMedia(media: Attachment) {
  const size = media.bytes >= 1024 * 1024 ? `${(media.bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(media.bytes / 1024))} KB`;
  return `${mediaLabels[media.kind]} · ${media.name} · ${size}`;
}
async function uploadChunk(request: Request, path: string, chunk: Blob) {
  try {
    return await request<UploadResponse>(path, "POST", chunk);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    if (typeof status === "number" && ![502, 503, 504].includes(status)) throw error;
    return request<UploadResponse>(path, "POST", chunk);
  }
}
function failure(error: unknown, subject = "这条计划"): Notice {
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  return { error: true, expired: status === 401, message: status === 409 ? `${subject}已在其他页面修改。草稿已保留，请加载最新版本后再保存。` : error instanceof Error ? error.message : "暂时无法连接，请稍后重试。" };
}
function countdown(next: number | null, now: number): string {
  if (!next) return "尚未安排";
  const seconds = Math.max(0, Math.ceil((next - now) / 1000));
  if (!seconds) return "已到时间，正在检查发送";
  const hours = Math.floor(seconds / 3600), days = Math.floor(hours / 24);
  const remaining = [hours % 24, Math.floor(seconds % 3600 / 60), seconds % 60].map(n => n.toString().padStart(2, "0")).join(":");
  return days ? `${days} 天 ${remaining}` : remaining;
}
function localDate(now: number) {
  const parts = dateFormat.formatToParts(now), value = (type: string) => parts.find(p => p.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function dayStart(date: string) {
  return Date.parse(`${date}T00:00:00+08:00`);
}
function upcoming(plans: ScheduledMessagePlan[], now: number) {
  const rows: { id: string; plan: ScheduledMessagePlan; at: number }[] = [], start = dayStart(localDate(now));
  for (const plan of plans.filter(p => p.enabled)) {
    if (plan.nextRunAt && plan.nextRunAt <= now) rows.push({ id: `${plan.id}-due`, plan, at: plan.nextRunAt });
    const days = plan.calendarDate ? [dayStart(plan.calendarDate)] : [start, start + dayMs];
    for (const dateStart of days) for (const time of plan.times) {
      if (!hourMinute.test(time)) continue;
      const [hour, minute] = time.split(":").map(Number), at = dateStart + hour * 3_600_000 + minute * 60_000;
      if (at > now && at <= now + dayMs) rows.push({ id: `${plan.id}-${at}`, plan, at });
    }
  }
  return rows.sort((a, b) => a.at - b.at || a.plan.name.localeCompare(b.plan.name)).slice(0, 24);
}

export default function TelegramScheduledMessages({ request, signInPath, workspace = "messages" }: Props) {
  const gameTips = workspace === "gameTips";
  const [status, setStatus] = useState<ScheduledMessageStatus | null>(null);
  const [tab, setTab] = useState<Tab>(gameTips ? "library" : "plans");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [captionExample, setCaptionExample] = useState(0);
  const [channelDraft, setChannelDraft] = useState<ChannelDraft | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
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

  async function mutate(label: string, method: string, body?: unknown, success?: string, subject?: string) {
    if (busyRef.current) return false;
    busyRef.current = true; epoch.current++; setBusy(label); setNotice(null);
    try {
      accept(await request<ScheduledMessageStatus>(endpoint, method, body));
      if (success) setNotice({ message: success });
      return true;
    } catch (error) {
      setNotice(failure(error, subject));
      if (error instanceof Error && "status" in error && error.status === 409) {
        try { accept(await request<ScheduledMessageStatus>(endpoint)); } catch { /* Keep the original conflict and draft. */ }
      }
      return false;
    } finally { busyRef.current = false; setBusy(""); setLoading(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    const limit = draft.media ? 1024 : 4096;
    if (isGameTipsDraft && (!draft.name.trim() || !draft.gameTipsProvider || draft.enabled && !providerReady)) {
      setNotice({ error: true, message: "请选择游戏平台并填写计划名称。启用计划前，同一平台至少需要 3 款可用游戏。" }); return;
    }
    if (!isGameTipsDraft && (!draft.name.trim() || !draft.text.trim() || draft.text.length > limit)) {
      setNotice({ error: true, message: `请填写名称和文案，文案最多 ${limit.toLocaleString()} 个字符。` }); return;
    }
    if (!draft.times.length || draft.times.some(time => !hourMinute.test(time)) || new Set(draft.times).size !== draft.times.length) {
      setNotice({ error: true, message: "请填写有效且不重复的发送时间。" }); return;
    }
    if (!draft.repeatDaily && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.calendarDate) || !Number.isFinite(dayStart(draft.calendarDate)))) {
      setNotice({ error: true, message: "请选择有效的发送日期。" }); return;
    }
    if (!draft.targetKeys.length) {
      setNotice({ error: true, message: "请至少选择一个发送频道。" }); return;
    }
    if (missingDraftTargets.length) {
      setNotice({ error: true, message: "请先从计划移除已删除的频道。" }); return;
    }
    if (await mutate("save", draft.id ? "PUT" : "POST", payloadOf(draft), draft.enabled ? "计划已保存，后台将按排期发布。" : "计划已保存，处于暂停状态。")) setDraft(null);
  }
  function open(plan?: ScheduledMessagePlan) {
    if (draft && !window.confirm("放弃当前未保存的草稿？")) return;
    setDraft(plan ? draftOf(plan, today, legacyTargetKeys) : freshDraft(today));
    setCaptionExample(0);
    setTab("plans"); setNotice(null);
  }
  function openGameTips(provider?: string) {
    if (draft && !window.confirm("放弃当前未保存的草稿？")) return;
    const chosen = provider || (readyProviders.length === 1 ? readyProviders[0].name : "");
    setDraft({
      ...freshDraft(today), name: provider && provider.length <= 88 ? `Game Tips · ${provider}` : "Game Tips", repeatDaily: true,
      gameTipsProvider: chosen, gameTipsCaptionPresetId: DEFAULT_GAME_TIPS_CAPTION_PRESET_ID,
    });
    setCaptionExample(0);
    setTab("plans"); setNotice(null);
  }
  async function remove(plan: ScheduledMessagePlan) {
    if (!window.confirm(`删除「${plan.name}」的发送计划？已发送的频道消息会保留。`)) return;
    if (await mutate(`delete-${plan.id}`, "DELETE", { id: plan.id, revision: plan.revision }, "计划已删除，未发送的安排已取消。")) {
      if (draft?.id === plan.id) setDraft(null);
    }
  }
  async function upload(file: File) {
    if (!draft || busyRef.current) return;
    const kind = file.type && file.type !== "application/octet-stream" ? file.type : mediaExtensions[file.name.split(".").at(-1)?.toLowerCase() || ""];
    const max = Object.hasOwn(mediaLimits, kind) ? mediaLimits[kind] : 0;
    if (!max || !file.size || file.size > max * 1024 * 1024) {
      setNotice({ error: true, message: max ? `文件不能为空，每个文件最多 ${max} MB。` : "请选择 JPG、PNG、MP4 或 GIF 文件。" });
      return;
    }
    busyRef.current = true; setBusy("upload"); setUploadProgress(0); setNotice(null);
    try {
      const uploadId = crypto.randomUUID();
      const query = `name=${encodeURIComponent(file.name)}&uploadId=${uploadId}&size=${file.size}`;
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        const end = Math.min(offset + chunkBytes, file.size);
        const chunk = file.slice(offset, end, file.type || "application/octet-stream");
        const result = await uploadChunk(request, `${uploadEndpoint}?${query}&offset=${offset}`, chunk);
        if (result?.id === uploadId && "kind" in result && end === file.size && Object.hasOwn(mediaLabels, result.kind)) {
          setDraft(current => current ? { ...current, media: result } : current);
          return;
        }
        if (result?.id !== uploadId || !("received" in result) || result.received !== end || end === file.size) {
          throw new Error("无法读取附件上传结果，请重试。");
        }
        setUploadProgress(Math.floor(end / file.size * 100));
      }
    } catch (error) {
      setNotice(failure(error));
    } finally {
      busyRef.current = false; setBusy("");
    }
  }
  function editChannel(target?: ScheduledMessageTarget) {
    if (channelDraft && !window.confirm("放弃当前未保存的频道设置？")) return;
    setChannelDraft(target
      ? { key: target.key, revision: target.revision, title: target.title, address: target.address }
      : { requestId: crypto.randomUUID(), title: "", address: "" });
    setNotice(null);
  }
  async function saveChannel(event: FormEvent) {
    event.preventDefault();
    if (!channelDraft?.title.trim() || !channelDraft.address.trim()) {
      setNotice({ error: true, message: "请填写频道名称和 Telegram 地址。" }); return;
    }
    const payload = { ...channelDraft, action: "upsertTarget", title: channelDraft.title.trim(), address: channelDraft.address.trim() };
    if (await mutate("save-channel", "POST", payload, "频道已保存，可在发送计划中选择。", "这个频道")) setChannelDraft(null);
  }
  async function removeChannel(target: ScheduledMessageTarget) {
    if (!window.confirm(`删除「${target.title}」？此频道将从文案定时和 Game Tips 的频道列表移除。`)) return;
    if (await mutate(`delete-channel-${target.key}`, "DELETE", { targetKey: target.key, revision: target.revision }, "频道已删除。", "这个频道") && channelDraft?.key === target.key) setChannelDraft(null);
  }
  function setTargetChecked(key: ScheduledMessageTargetKey, checked: boolean) {
    setDraft(previous => {
      if (!previous || checked === previous.targetKeys.includes(key)) return previous;
      const targetKeys = checked ? [...previous.targetKeys, key] : previous.targetKeys.filter(value => value !== key);
      return { ...previous, targetKeys };
    });
  }
  const now = anchor.current.now + Math.max(0, clientNow - anchor.current.receivedAt);
  const today = localDate(now);
  const plans = (status?.plans || []).filter(plan => Boolean(plan.gameTipsProvider) === gameTips);
  const current = draft?.id ? plans.find(plan => plan.id === draft.id) : null;
  const conflict = Boolean(draft?.id && (!current || current.revision !== draft.revision));
  const targets = status?.targets || [], legacyTargetKeys = targets.filter(target => !target.key.startsWith("custom:")).map(target => target.key);
  const targetsByKey = new Map(targets.map(target => [target.key, target]));
  const selectedTargets = draft?.targetKeys || [];
  const missingDraftTargets = selectedTargets.filter(key => !targetsByKey.has(key));
  const targetTitles = (plan: ScheduledMessagePlan) => (plan.targetKeys ?? legacyTargetKeys).map(key => targetsByKey.get(key)?.title || "已删除频道");
  const editedChannel = channelDraft?.key ? targetsByKey.get(channelDraft.key) : undefined;
  const channelConflict = Boolean(channelDraft?.key && editedChannel?.revision !== channelDraft.revision);
  const enabledPlans = plans.filter(plan => plan.enabled && (!plan.calendarDate || plan.calendarDate >= today));
  const summary = gameTips ? status?.gameTipsSummary : status?.messageSummary;
  const next = summary ? summary.nextRunAt
    : enabledPlans.reduce<number | null>((first, plan) => plan.nextRunAt && (!first || plan.nextRunAt < first) ? plan.nextRunAt : first, null);
  const schedulerError = summary?.lastError ?? status?.scheduler.lastError;
  const heartbeat = status?.scheduler.heartbeatAt || 0;
  const healthy = Boolean(status?.scheduler.workerHealthy && heartbeat && now - heartbeat < 60_000);
  const targetsReady = Boolean(status?.hasToken && selectedTargets.length && selectedTargets.every(key => targetsByKey.get(key)?.ready));
  const gameTipsProviders = status?.gameTipsProviders || [];
  const readyProviders = gameTipsProviders.filter(provider => provider.count >= 3);
  const readyProviderKeys = new Set(readyProviders.map(provider => gameTipsProviderKey(provider.name)));
  const isGameTipsDraft = draft?.gameTipsProvider !== undefined;
  const draftProviderKey = draft?.gameTipsProvider ? gameTipsProviderKey(draft.gameTipsProvider) : "";
  const draftProvider = gameTipsProviders.find(provider => gameTipsProviderKey(provider.name) === draftProviderKey);
  const providerReady = (draftProvider?.count ?? 0) >= 3;
  const gameTipsProviderName = draftProvider?.name ?? draft?.gameTipsProvider ?? "";
  const captionPresetId = draft?.gameTipsCaptionPresetId || DEFAULT_GAME_TIPS_CAPTION_PRESET_ID;
  const captionBody = GAME_TIPS_CAPTION_BODIES[captionExample];
  const gameTipsTimeCount = new Set(draft?.times.filter(time => hourMinute.test(time))).size;
  const pastCount = plans.filter(plan => plan.calendarDate && plan.calendarDate < today).length;
  const visiblePlans = plans.filter(plan => showPast || !plan.calendarDate || plan.calendarDate >= today);
  const dates = [...new Set(visiblePlans.map(plan => plan.calendarDate || ""))].sort((left, right) => {
    if (!left) return 1;
    if (!right) return -1;
    if ((left < today) !== (right < today)) return left < today ? 1 : -1;
    return left < today ? right.localeCompare(left) : left.localeCompare(right);
  });
  const timeline = upcoming(plans, now);
  const workspaceDeliveries = (status?.deliveries || []).filter(item => Boolean(item.gameTipsProvider) === gameTips);
  const deliveries = workspaceDeliveries.filter(item => historyFilter === "all" || item.status === historyFilter);
  const counts = summary?.counts ?? Object.fromEntries(Object.keys(statusLabels)
    .map(key => [key, workspaceDeliveries.filter(item => item.status === key).length]));
  function updateGameTipsProviders(providers: GameTipsProvider[], refreshSchedules = false) {
    epoch.current++;
    setStatus(currentStatus => currentStatus ? { ...currentStatus, gameTipsProviders: providers } : currentStatus);
    if (refreshSchedules) void mutate("refresh", "GET");
  }

  return <section className="cms-settings-form cms-scheduled-messages" aria-labelledby="scheduled-messages-title">
    <div className="cms-settings-panel">
      <div className="cms-scheduled-heading">
        <div><h2 id="scheduled-messages-title">{gameTips ? "Game Tips 自动发布" : "频道文案定时发布"}</h2>
          <p>{gameTips ? "从所选平台抽取游戏图片，合成并附上选定文案，按马来西亚时间发往 Telegram。" : "按马来西亚时间安排文案和媒体，自动发布到所选频道。"}</p></div>
        <div className="cms-scheduled-actions">
          <span className={`cms-scheduled-pill ${healthy ? "cms-scheduled-good" : ""}`}>{healthy ? "后台定时服务运行中" : loading ? "正在连接…" : "定时服务需要检查"}</span>
          <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => void mutate("refresh", "GET")}><RefreshCw size={14} className={busy === "refresh" ? "cms-spin" : ""} />刷新状态</button>
        </div>
      </div>
      {notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>{notice.message}{notice.expired && <a href={signInPath} target="_top">重新登入 ↗</a>}</div>}
      {loading && !status ? <p className="cms-scheduled-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载每日计划…</p> : !status ?
        <div className="cms-scheduled-empty"><strong>暂时无法加载计划</strong><p>请刷新状态后重试。</p></div> : <>
        <div className="cms-scheduled-overview">
          <div><small><Clock3 size={13} />马来西亚时间（UTC+8）</small><strong>{displayTime(now)}</strong><span>后台检查：{displayTime(status.scheduler.lastCompletedAt || status.scheduler.lastTickAt)}</span></div>
          <div className="cms-scheduled-next"><small>下次自动发送</small><strong>{displayTime(next)}</strong><span>{countdown(next, now)}</span></div>
        </div>
        {schedulerError && <p className="cms-scheduled-error" role="alert">运行异常 · {schedulerError}</p>}
        <div className={`cms-scheduled-tabs${gameTips ? "" : " cms-scheduled-tabs-messages"}`} role="tablist" aria-label={gameTips ? "Game Tips 管理" : "频道文案管理"}>
          {(gameTips ? gameTipsTabs : messageTabs).map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`scheduled-tab-${id}`} aria-controls={`scheduled-panel-${id}`} aria-selected={tab === id} onClick={() => setTab(id)}><Icon size={15} />{label}{id === "plans" && <small>{plans.length}</small>}</button>)}
        </div>
        <div id="scheduled-panel-plans" role="tabpanel" aria-labelledby="scheduled-tab-plans" hidden={tab !== "plans"} className="cms-scheduled-panel">
          <div className="cms-scheduled-heading">
            <div><h3>{gameTips ? "Game Tips 发送计划" : "每日文案计划"}</h3><p>{plans.length} 条计划 · {enabledPlans.length} 条已启用</p></div>
            <div className="cms-scheduled-actions">
              {pastCount > 0 && <button type="button" className="cms-secondary" aria-pressed={showPast} onClick={() => setShowPast(value => !value)}><History size={14} />{showPast ? "隐藏过往日期" : "显示过往日期"}</button>}
              {gameTips
                ? <button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => openGameTips()}><Plus size={15} />添加 Game Tips</button>
                : <button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => open()}><Plus size={15} />添加文案</button>}
            </div>
          </div>
          {draft && <form ref={editor} className="cms-scheduled-card cms-scheduled-editor" onSubmit={save}>
            <fieldset disabled={Boolean(busy)}>
              <div className="cms-scheduled-heading"><h3>{isGameTipsDraft ? "Game Tips 发送计划" : draft.id ? "编辑文案计划" : "添加文案计划"}</h3><button type="button" className="cms-icon-button" aria-label="关闭文案编辑" onClick={() => { if (window.confirm("放弃当前未保存的草稿？")) setDraft(null); }}><X size={16} /></button></div>
              {conflict && <div className="cms-scheduled-conflict" role="alert"><span>{current ? "这条计划已有新版本，当前草稿尚未保存。" : "这条计划已被删除，草稿尚未保存。"}</span>{current && <button type="button" className="cms-secondary" onClick={() => { if (window.confirm("加载最新版本会替换当前未保存的草稿，继续？")) setDraft(draftOf(current, today, legacyTargetKeys)); }}>加载最新版本</button>}</div>}
              <div className="cms-scheduled-form-grid">
                <label>后台名称<input required autoComplete="off" maxLength={100} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：周五上午活动" /><small>供后台辨认这条文案。</small></label>
                <div className="cms-scheduled-date-field">
                  {!draft.repeatDaily && <label>发送日期（MYT）<input type="date" required value={draft.calendarDate} onChange={event => setDraft({ ...draft, calendarDate: event.target.value })} /></label>}
                  {draft.repeatDaily && <span className="cms-scheduled-muted">{isGameTipsDraft ? "每日按马来西亚时间重新抽图并生成文案。" : "每天使用同一份文案和附件。"}</span>}
                  <label className="cms-telegram-switch"><input type="checkbox" checked={draft.repeatDaily} onChange={event => setDraft({ ...draft, repeatDaily: event.target.checked })} />每天重复</label>
                </div>
              </div>
              {isGameTipsDraft ? <div className="cms-scheduled-media cms-game-tips-plan">
                <div className="cms-scheduled-heading">
                  <div><h3>随机选图与发送文案</h3><p>每次从同一平台抽 3 款不同游戏，合成一张图并附上文案。</p></div>
                  <button type="button" className="cms-secondary" onClick={() => setTab("library")}><Images size={14} />管理图库</button>
                </div>
                <label>游戏平台<select value={gameTipsProviderName} required onChange={event => setDraft({ ...draft, gameTipsProvider: event.target.value })}>
                  <option value="">选择游戏平台</option>
                  {draft.gameTipsProvider && !draftProvider && <option value={draft.gameTipsProvider}>{draft.gameTipsProvider} · 0 款可用</option>}
                  {gameTipsProviders.map(provider => <option key={provider.name} value={provider.name}>{provider.name} · {provider.count} 款可用</option>)}
                </select></label>
                {!providerReady && <small className="cms-scheduled-error">请在图库为此平台准备至少 3 款不同且已启用的游戏。</small>}
                <label>发送文案<select value={captionPresetId} onChange={event => setDraft({ ...draft, gameTipsCaptionPresetId: event.target.value })}>
                  {GAME_TIPS_CAPTION_PRESETS.map(preset => <option value={preset.id} key={preset.id}>{preset.label}</option>)}
                </select><small>这里选择文案标题。每次排期发送时，系统会从 {GAME_TIPS_CAPTION_BODIES.length} 条中段文案中随机选一条。</small></label>
                <details className="cms-game-tips-copy" open>
                  <summary>预览 Telegram 文案</summary>
                  <p aria-live="polite">{gameTipsCaption(gameTipsProviderName || "游戏平台", captionPresetId, captionBody)}</p>
                  <small className="cms-scheduled-muted">Telegram 按钮 · Visit website · NEED HELP?</small>
                  <div className="cms-scheduled-actions">
                    <button type="button" className="cms-secondary" onClick={() => setCaptionExample(index => (index + 1) % GAME_TIPS_CAPTION_BODIES.length)}><RefreshCw size={14} />下一条示例</button>
                    <span className="cms-scheduled-muted">示例 {captionExample + 1} / {GAME_TIPS_CAPTION_BODIES.length}</span>
                  </div>
                </details>
                {providerReady && <a className="cms-secondary cms-scheduled-save-channel" href={`/api/admin/telegram/game-tips?preview=${encodeURIComponent(gameTipsProviderName)}`} target="_blank" rel="noopener noreferrer"><Images size={14} />预览合成图样式 ↗</a>}
              </div> : <>
              <label>发送文案<textarea required rows={7} maxLength={draft.media ? 1024 : 4096} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} placeholder="输入要发布的文案" /><small>{draft.text.length.toLocaleString()} / {draft.media ? "1,024 · 文案会作为附件说明一起发送。" : "4,096 · 保留文字、表情及换行。"}</small></label>
              <div className="cms-scheduled-media">
                <div className="cms-scheduled-heading">
                  <div><h3>照片、视频或 GIF</h3><p>每条文案可加一个附件。JPG / PNG 10 MB，MP4 50 MB，GIF 20 MB。</p></div>
                  <label className="cms-secondary cms-scheduled-file-button">
                    {busy === "upload" ? <LoaderCircle size={14} className="cms-spin" /> : <Upload size={14} />}
                    <span aria-hidden="true">{busy === "upload" ? "正在上传…" : draft.media ? "更换附件" : "上传附件"}</span>
                    <input type="file" accept="image/jpeg,image/png,image/gif,video/mp4,.jpg,.jpeg,.png,.gif,.mp4" aria-label={draft.media ? "更换附件" : "上传附件"} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
                  </label>
                </div>
                {busy === "upload" && <progress aria-label="附件上传进度" max={100} value={uploadProgress} />}
                {draft.media && <div className="cms-scheduled-attachment">
                  {draft.media.kind === "video"
                    ? <video controls playsInline preload="metadata" aria-label="上传视频预览" src={`${uploadEndpoint}?id=${encodeURIComponent(draft.media.id)}`} />
                    : <img loading="lazy" src={`${uploadEndpoint}?id=${encodeURIComponent(draft.media.id)}`} alt="上传附件预览" />}
                  <div><strong>{describeMedia(draft.media)}</strong><button type="button" className="cms-secondary" onClick={() => setDraft({ ...draft, media: null })}><X size={14} />移除附件</button></div>
                </div>}
              </div>
              </>}
              <div role="group" aria-labelledby="scheduled-target-choices" className="cms-scheduled-time-fields">
                <div className="cms-scheduled-heading"><h3 id="scheduled-target-choices">发送频道</h3><button type="button" className="cms-secondary" onClick={() => setTab("channels")}><Radio size={14} />管理频道</button></div>
                <div className="cms-scheduled-target-choices">{targets.map(target => {
                  const checked = selectedTargets.includes(target.key);
                  return <label key={target.key} className="cms-scheduled-target-choice">
                    <input type="checkbox" checked={checked} onChange={event => setTargetChecked(target.key, event.currentTarget.checked)} />
                    <span><strong>{target.title}</strong><small>{target.address || target.chatId || "尚未连接"}</small></span>
                    <span className={target.ready ? "cms-scheduled-ready-text" : "cms-scheduled-muted"}>{target.ready ? "可发布" : "待检查"}</span>
                  </label>;
                })}</div>
                {targets.length ? <small>此计划只会发到你勾选的频道。</small> : <small>请先添加发送频道。</small>}
                {missingDraftTargets.length > 0 && <div className="cms-scheduled-conflict" role="alert">
                  <span>此计划选择了 {missingDraftTargets.length} 个已删除的频道。请移除后再保存。</span>
                  <button type="button" className="cms-secondary" onClick={() => setDraft(previous => previous
                    && { ...previous, targetKeys: previous.targetKeys.filter(key => targetsByKey.has(key)) })}>从计划移除已删除频道</button>
                </div>}
              </div>
              <div className="cms-scheduled-time-fields"><div className="cms-scheduled-heading"><h3>发送时间（MYT）</h3><button type="button" className="cms-secondary" disabled={draft.times.length >= 24} onClick={() => setDraft({ ...draft, times: [...draft.times, ""] })}><Plus size={14} />添加时间</button></div>
                {draft.times.map((time, index) => <div className="cms-scheduled-time-input" key={index}><label>时间 {index + 1}<input type="time" step="60" required value={time} onChange={event => setDraft({ ...draft, times: draft.times.map((value, i) => i === index ? event.target.value : value) })} /></label><button type="button" className="cms-icon-button" disabled={draft.times.length === 1} aria-label={`移除时间 ${index + 1}`} onClick={() => setDraft({ ...draft, times: draft.times.filter((_, i) => i !== index) })}><Trash2 size={14} /></button></div>)}
                <small>{isGameTipsDraft ? `${draft.repeatDaily ? "每天" : "所选日期"}发送 ${gameTipsTimeCount} 次，每个设定时间向所有勾选频道各发送 1 次。` : draft.repeatDaily ? "每天按所选时间发布。" : "只在所选日期发布。隔天的文案和附件可另加一条计划。"}</small>
                {isGameTipsDraft && !draft.repeatDaily && <small>单日计划可单独安排时间。同日仍启用的每日计划也会照常发布。</small>}
              </div>
              <label className="cms-telegram-switch"><input type="checkbox" role="switch" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />保存后启用自动发送</label>
              {draft.enabled && !targetsReady && <small className="cms-scheduled-error">启用时将核实所选频道的发布权限。也可先暂停保存。</small>}
              <div className="cms-scheduled-actions"><button className="cms-primary" type="submit" disabled={conflict || missingDraftTargets.length > 0 || isGameTipsDraft && draft.enabled && !providerReady}>{busy === "save" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}{isGameTipsDraft ? "保存 Game Tips 排期" : "保存文案与时间"}</button><span className="cms-scheduled-muted">草稿需保存后才会生效</span></div>
            </fieldset>
          </form>}
          {!visiblePlans.length && !draft && <div className="cms-scheduled-empty">
            <strong>{gameTips ? "目前没有 Game Tips 排期" : "目前没有待排文案"}</strong>
            <p>{gameTips ? "选择游戏平台、文案、时间和频道，保存后即可启用。" : "添加一条文案，选择日期、时间和频道，再启用自动发布。"}</p>
          </div>}
          {dates.map(date => <div key={date || "daily"} className="cms-scheduled-plan-list">
            <h4 className="cms-scheduled-day"><CalendarClock size={15} />{date ? <><time dateTime={date}>{date}</time>{date === today && <span className="cms-scheduled-pill cms-scheduled-good">今天</span>}</> : "每天重复"}</h4>
            {visiblePlans.filter(plan => (plan.calendarDate || "") === date).sort((left, right) => left.times[0].localeCompare(right.times[0])).map(plan => {
              const past = Boolean(date && date < today);
              const missingTargets = plan.targetKeys?.some(key => !targetsByKey.has(key));
              return <article className="cms-scheduled-card" key={plan.id}>
                <div className="cms-scheduled-heading">
                  <div><h3>{plan.name}</h3><span className={`cms-scheduled-pill ${plan.enabled && !past ? "cms-scheduled-good" : ""}`}>{past ? "日期已过" : plan.enabled ? "已启用" : "已暂停"}</span></div>
                  <div className="cms-scheduled-actions">
                    <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => open(plan)}><Pencil size={14} />编辑</button>
                    {!past && <button type="button" className="cms-secondary" disabled={Boolean(busy) || !plan.enabled && (missingTargets || Boolean(plan.gameTipsProvider && !readyProviderKeys.has(gameTipsProviderKey(plan.gameTipsProvider))))} onClick={() => void mutate(`toggle-${plan.id}`, "PUT", payloadOf({ ...draftOf(plan, today, legacyTargetKeys), enabled: !plan.enabled }), plan.enabled ? "计划已暂停。" : "计划已启用。")}>{plan.enabled ? <Pause size={14} /> : <Play size={14} />}{plan.enabled ? "暂停" : "启用"}</button>}
                    <button type="button" className="cms-icon-button" aria-label={`删除计划 ${plan.name}`} disabled={Boolean(busy)} onClick={() => void remove(plan)}><Trash2 size={15} /></button>
                  </div>
                </div>
                {plan.gameTipsProvider ? <div className="cms-scheduled-attachment-label"><Gamepad2 size={15} />{plan.gameTipsProvider} · {GAME_TIPS_CAPTION_PRESETS.find(preset => preset.id === (plan.gameTipsCaptionPresetId || DEFAULT_GAME_TIPS_CAPTION_PRESET_ID))?.label} · 随机 3 款游戏</div> : <p className="cms-scheduled-copy">{plan.text}</p>}
                {plan.gameTipsIssue && <p className="cms-scheduled-error">{plan.gameTipsIssue}</p>}
                {missingTargets && !past && <p className="cms-scheduled-error">此计划有已删除的频道，请编辑并更新发送频道。</p>}
                {plan.media && <div className="cms-scheduled-attachment-label"><Paperclip size={14} />{describeMedia(plan.media)}</div>}
                <div className="cms-scheduled-plan-times">{plan.times.map(time => <span key={time}><Clock3 size={12} />{time}</span>)}</div>
                <small className="cms-scheduled-muted">频道 · {targetTitles(plan).join("、")}<br />下次 · {displayTime(plan.nextRunAt)}　最近安排 · {displayTime(plan.lastRunAt)}</small>
              </article>;
            })}
          </div>)}
        </div>
        {gameTips && <div id="scheduled-panel-library" role="tabpanel" aria-labelledby="scheduled-tab-library" hidden={tab !== "library"} className="cms-scheduled-panel">
          <TelegramGameTipsLibrary request={request} signInPath={signInPath} active={tab === "library"}
            plans={plans} today={today} onProvidersChanged={updateGameTipsProviders} onSchedule={openGameTips} onEditSchedule={open} />
        </div>}
        <div id="scheduled-panel-channels" role="tabpanel" aria-labelledby="scheduled-tab-channels" hidden={tab !== "channels"} className="cms-scheduled-panel">
          <div className="cms-scheduled-heading">
            <div><h3>发送频道</h3><p>将 @FreeBonus365ChatBot 设为频道管理员并开启发布权限，然后检查频道。</p></div>
            <div className="cms-scheduled-actions">
              <button type="button" className="cms-secondary" disabled={Boolean(busy) || !status.hasToken} onClick={() => void mutate("verify", "POST", { action: "verify" }, "频道权限检查已完成。")}>{busy === "verify" ? <LoaderCircle size={14} className="cms-spin" /> : <RefreshCw size={14} />}检查频道权限</button>
              <button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => editChannel()}><Plus size={15} />添加频道</button>
            </div>
          </div>
          {!status.hasToken && <p className="cms-scheduled-error">请先在 Telegram 聊天机器人设置中保存 Token。</p>}
          {channelDraft && <form className="cms-scheduled-card cms-scheduled-editor" onSubmit={saveChannel}>
            <fieldset disabled={Boolean(busy)}>
              <div className="cms-scheduled-heading"><h3>{channelDraft.key ? "编辑频道" : "新增频道"}</h3><button type="button" className="cms-icon-button" aria-label="关闭频道编辑" onClick={() => { if (window.confirm("放弃当前未保存的频道设置？")) setChannelDraft(null); }}><X size={16} /></button></div>
              {channelConflict && <div className="cms-scheduled-conflict" role="alert"><span>{editedChannel ? "频道已有新版本，当前草稿尚未保存。" : "这个频道已被删除，当前草稿尚未保存。"}</span>{editedChannel && <button type="button" className="cms-secondary" onClick={() => editChannel(editedChannel)}>加载最新频道</button>}</div>}
              <div className="cms-scheduled-form-grid">
                <label>频道名称<input autoFocus required autoComplete="off" maxLength={100} value={channelDraft.title} onChange={event => setChannelDraft({ ...channelDraft, title: event.target.value })} placeholder="例如：活动公告频道" /></label>
                <label>Telegram 频道地址<input required autoComplete="off" maxLength={120} value={channelDraft.address} onChange={event => setChannelDraft({ ...channelDraft, address: event.target.value })} placeholder="@channelname 或 -1001234567890" /><small>支持公开用户名、公开 t.me 链接或私人频道数字 ID。</small></label>
              </div>
              <button type="submit" className="cms-primary cms-scheduled-save-channel" disabled={channelConflict}>{busy === "save-channel" ? <LoaderCircle size={15} className="cms-spin" /> : <Check size={15} />}保存频道</button>
            </fieldset>
          </form>}
          {!targets.length && <div className="cms-scheduled-empty">尚未添加发送频道。</div>}
          <div className="cms-scheduled-targets">{targets.map(target => <div key={target.key}>
            <div><strong>{target.title}</strong><small>{target.address || target.chatId || "尚未连接"}</small></div>
            <span className={`cms-scheduled-pill ${target.ready ? "cms-scheduled-good" : "cms-scheduled-attention"}`}>{target.ready ? "可发布" : "需要检查"}</span>
            <div className="cms-scheduled-target-actions">
              <button type="button" className="cms-secondary" disabled={Boolean(busy)} aria-label={`编辑频道 ${target.title}`} onClick={() => editChannel(target)}><Pencil size={14} />编辑</button>
              <button type="button" className="cms-secondary" disabled={Boolean(busy)} aria-label={`删除频道 ${target.title}`} onClick={() => void removeChannel(target)}><Trash2 size={14} />删除</button>
            </div>
            {target.lastError && <p className="cms-scheduled-error">{target.lastError}</p>}
          </div>)}</div>
        </div>
        <div id="scheduled-panel-time" role="tabpanel" aria-labelledby="scheduled-tab-time" hidden={tab !== "time"} className="cms-scheduled-panel">
          <div className="cms-scheduled-card">
            <div className="cms-scheduled-heading"><div><h3>接下来 24 小时</h3><p>按马来西亚当地日期与时间排列。</p></div></div>
            {timeline.length ? <ol className="cms-scheduled-timeline">{timeline.map(row => <li key={row.id}>
              <time dateTime={new Date(row.at).toISOString()}>{displayTime(row.at)}</time>
              <div><strong>{row.plan.name}</strong><small>{row.at <= now ? "已到时间，等待后台处理" : targetTitles(row.plan).join("、")}</small></div>
            </li>)}</ol> : <div className="cms-scheduled-empty">接下来 24 小时没有已启用的发送安排。</div>}
          </div>
          <div className="cms-scheduled-note"><p>每日排期会在马来西亚时间 00:00 换日。{gameTips && "每次到达设定时间，系统会重新从所选平台抽图。"}</p><p>关闭页面或刷新后，已保存的安排仍由后台发送。遇到 Telegram 回执不明时，可在发送记录核对「待确认」状态。</p></div>
        </div>
        <div id="scheduled-panel-history" role="tabpanel" aria-labelledby="scheduled-tab-history" hidden={tab !== "history"} className="cms-scheduled-panel">
          <dl className="cms-scheduled-counts">{Object.entries(statusLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts[key] || 0}</dd></div>)}</dl>
          <div className="cms-scheduled-heading"><div><h3>逐频道发送记录</h3><p>同一次计划的结果按频道显示。</p></div><label className="cms-scheduled-filter">状态<select value={historyFilter} onChange={event => setHistoryFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
          {deliveries.length ? <div className="cms-scheduled-history">{deliveries.map(item => <article className="cms-scheduled-card" key={item.id}><div className="cms-scheduled-heading"><div><h3>{item.planName}</h3><p>{item.gameTipsProvider ? `${item.gameTipsProvider} · ` : ""}{item.targetTitle}</p></div><span className={`cms-scheduled-pill ${item.status === "sent" ? "cms-scheduled-good" : item.status === "failed" || item.status === "unknown" ? "cms-scheduled-attention" : ""}`}>{statusLabels[item.status] || item.status}</span></div><small className="cms-scheduled-muted">计划：{displayTime(item.runAt)} · 发送：{displayTime(item.sentAt)}{item.messageId ? ` · 消息 #${item.messageId}` : ""}</small>{item.lastError && <p className="cms-scheduled-error">{item.lastError}</p>}</article>)}</div> : <div className="cms-scheduled-empty">暂无{historyFilter === "all" ? "" : statusLabels[historyFilter]}发送记录。</div>}
        </div>
      </>}
    </div>
  </section>;
}
