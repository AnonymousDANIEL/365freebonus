"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Check, Clock3, Film, LoaderCircle, Pencil, Play, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { cancelHotVideoUpload, getHotVideoUploadResumes, HotVideoUploadError, uploadHotVideoFile,
  type SavedHotVideoUpload, type UploadProgress } from "./hot-video-upload-client";
import "./telegram-hot-videos-admin.css";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = { request: AdminRequest; signInPath: string };
type HotVideo = { id: string; title: string; originalName: string; bytes: number; active: boolean; createdAt: number; lastSentAt: number | null };
type HotJob = { id: string; videoId: string; title: string; kind: "manual" | "scheduled" | "automatic"; runAt: number;
  status: string; attempts: number; lastError: string; sentAt: number | null; messageId: number | null };
type HotStatus = { enabled: boolean; targetChatId: string; targetTitle: string; intervalHours: number; nextRunAt: number | null;
  revision: string; ready: boolean; lastError: string; lastCheckedAt: number | null;
  storage: { bytes: number; maxBytes: number; maxVideoBytes: number };
  videos: HotVideo[]; jobs: HotJob[]; counts: Record<string, number>; candidates?: { chatId: string; title: string }[] };
type Draft = { enabled: boolean; targetChatId: string; intervalHours: number; firstRunAt: string; revision?: string };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };

const endpoint = "/api/admin/telegram/hot-videos";
const maxVideoBytes = 50 * 1024 * 1024;
const buttons = [
  { text: "🌐 Visit website", url: "https://365freebonus.com/" },
  { text: "🎁 365 Free Bonus Official", url: "https://t.me/join365freebonus" },
  { text: "🎁 365 Free Bonus Group", url: "https://t.me/join365freebonusgroup" },
];
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const statusLabels: Record<string, string> = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", cancelled: "已取消", skipped: "已跳过" };
const kindLabels = { manual: "立即发送", scheduled: "指定时间", automatic: "自动轮播" } as const;
const formatTime = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? timeFormat.format(value) : "—";
const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
function dateValue(value: string): number | null {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? Date.parse(`${value}:00+08:00`) : null;
}
function shortTitle(value: string): string {
  let result = "";
  for (const character of value) { if (result.length + character.length > 120) break; result += character; }
  return result;
}
function draftFromStatus(status: HotStatus): Draft {
  return { enabled: status.enabled, targetChatId: status.targetChatId || "", intervalHours: status.intervalHours || 6, firstRunAt: "", revision: status.revision };
}
function failed(error: unknown): Notice {
  return { message: error instanceof Error ? error.message : "暂时无法完成操作，请稍后重试。", error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401 };
}

export default function TelegramHotVideos({ request, signInPath }: Props) {
  const [status, setStatus] = useState<HotStatus | null>(null);
  const [draft, setDraft] = useState<Draft>({ enabled: false, targetChatId: "", intervalHours: 6, firstRunAt: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reload, setReload] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadProgress["phase"]>("preparing");
  const [savedUpload, setSavedUpload] = useState<SavedHotVideoUpload | null>(null);
  const [uploadInputKey, setUploadInputKey] = useState(0);
  const [scheduledTimes, setScheduledTimes] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const dirtyRef = useRef(false);
  const busyRef = useRef("");
  const mutationEpoch = useRef(0);
  const uploadRef = useRef<AbortController | null>(null);
  const uploadSession = useRef<SavedHotVideoUpload | null>(null);
  const cancelRequested = useRef(false);
  const mounted = useRef(true);
  const sendIds = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true, polling = false;
    async function read(initial: boolean) {
      if (polling || busyRef.current || !initial && document.visibilityState === "hidden") return;
      const epoch = mutationEpoch.current;
      polling = true;
      if (initial) setLoading(true);
      try {
        const value = await request<HotStatus>(endpoint);
        if (!active || epoch !== mutationEpoch.current) return;
        setStatus(value);
        if (!dirtyRef.current) setDraft(draftFromStatus(value));
      } catch (error) { if (active) setNotice(failed(error)); }
      finally { polling = false; if (active && initial) setLoading(false); }
    }
    void read(true);
    const timer = setInterval(() => void read(false), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [request, reload]);
  useEffect(() => {
    mounted.current = true;
    const cached = getHotVideoUploadResumes().at(-1) || null;
    setSavedUpload(cached); uploadSession.current = cached;
    return () => { mounted.current = false; uploadRef.current?.abort(); };
  }, []);

  function change(patch: Partial<Draft>) {
    dirtyRef.current = true; setDirty(true); setNotice(null); setDraft(current => ({ ...current, ...patch }));
  }
  function setWorking(value: string) { if (value) mutationEpoch.current++; busyRef.current = value; setBusy(value); }
  function accept(value: HotStatus, replaceDraft = false) {
    setStatus(value);
    if (replaceDraft || !dirtyRef.current) setDraft(draftFromStatus(value));
    if (replaceDraft) { dirtyRef.current = false; setDirty(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || loading) return;
    const firstRunAt = draft.enabled && draft.firstRunAt ? dateValue(draft.firstRunAt) : null;
    if (draft.enabled && draft.firstRunAt && (!firstRunAt || firstRunAt <= Date.now())) { setNotice({ message: "首发时间需晚于现在，请使用马来西亚时间。", error: true }); return; }
    setWorking("save"); setNotice(null);
    try {
      const value = await request<HotStatus>(endpoint, "PUT", { enabled: draft.enabled, targetChatId: draft.targetChatId.trim(),
        intervalHours: draft.intervalHours, firstRunAt, revision: draft.revision });
      accept(value, true);
      setNotice({ message: value.enabled ? `自动发布已保存，下次发送：${formatTime(value.nextRunAt)}（MYT）。` : "设置已保存，自动轮播已暂停。仍可立即发送或安排单次任务。" });
    } catch (error) { setNotice(failed(error)); }
    finally { setWorking(""); }
  }
  async function action(key: string, body: unknown, success: string): Promise<boolean> {
    if (busyRef.current) return false;
    setWorking(key); setNotice(null);
    try { accept(await request<HotStatus>(endpoint, "POST", body)); setNotice({ message: success }); return true; }
    catch (error) { setNotice(failed(error)); return false; }
    finally { setWorking(""); }
  }
  async function send(video: HotVideo, scheduled: boolean) {
    if (dirtyRef.current) { setNotice({ message: "请先保存频道和自动发布设置，再发送视频。", error: true }); return; }
    const runAt = scheduled ? dateValue(scheduledTimes[video.id] || "") : null;
    if (scheduled && (!runAt || runAt <= Date.now())) { setNotice({ message: "请选择晚于现在的发送时间（马来西亚时间）。", error: true }); return; }
    const key = `${video.id}:${runAt ?? "now"}`;
    const requestId = sendIds.current.get(key) || crypto.randomUUID();
    sendIds.current.set(key, requestId);
    const done = await action(`send:${video.id}`, { action: "send", videoId: video.id, runAt, requestId }, scheduled
      ? `已安排 ${formatTime(runAt)}（MYT）发送，请查看发送记录。` : "已加入立即发送队列，请查看发送记录确认结果。");
    if (done) sendIds.current.delete(key);
  }
  function chooseFile(value: File | null) {
    setNotice(null);
    if (!value) { setFile(null); return; }
    if (!/\.mp4$/i.test(value.name) || value.size <= 0 || value.size > (status?.storage.maxVideoBytes || maxVideoBytes)) {
      setFile(null); setUploadInputKey(key => key + 1); setNotice({ message: "请选择不超过 50 MB 的 MP4 视频。", error: true }); return;
    }
    setFile(value);
    const cached = getHotVideoUploadResumes().find(item => item.originalName === value.name && item.bytes === value.size && item.lastModified === value.lastModified) || null;
    setSavedUpload(cached); uploadSession.current = cached;
    if (cached) setUploadTitle(cached.title);
    else if (!uploadTitle || savedUpload) setUploadTitle(shortTitle(value.name.replace(/\.mp4$/i, "")));
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busyRef.current) return;
    const selected = file;
    const controller = new AbortController(); uploadRef.current = controller; cancelRequested.current = false;
    setWorking("upload"); setUploadPercent(0); setUploadPhase("preparing"); setNotice(null);
    try {
      const value = await uploadHotVideoFile<HotStatus>({ file: selected, title: uploadTitle, signal: controller.signal,
        onProgress: value => {
          if (!mounted.current) return;
          setUploadPhase(value.phase);
          setUploadPercent(Math.min(100, Math.max(0, Math.round((value.acknowledgedBytes + value.loadedBytes) / value.totalBytes * 100))));
        },
        onSession: value => { uploadSession.current = value; if (mounted.current) setSavedUpload(value); },
      });
      if (!mounted.current) return;
      accept(value); setFile(null); setUploadTitle(""); setUploadInputKey(key => key + 1);
      uploadSession.current = null; setSavedUpload(null);
      setNotice({ message: "视频已保存。可立即发送、指定时间发送，或加入自动轮播。" });
    } catch (error) {
      if (cancelRequested.current && uploadSession.current) {
        try {
          await cancelHotVideoUpload(uploadSession.current.id);
          uploadSession.current = null;
          if (mounted.current) { setSavedUpload(null); setNotice({ message: "上传已停止。已经完整保存的视频会保留在列表。" }); setReload(value => value + 1); }
        } catch (cancelError) { if (mounted.current) setNotice(failed(cancelError)); }
      } else if (mounted.current && !(error instanceof HotVideoUploadError && error.kind === "aborted" && !cancelRequested.current)) {
        setNotice(error instanceof HotVideoUploadError && error.kind === "aborted" ? { message: "上传已停止。" } : failed(error));
      }
    }
    finally { uploadRef.current = null; setUploadPercent(null); setWorking(""); }
  }
  async function discardUpload() {
    if (!savedUpload || busyRef.current) return;
    setWorking("cancel-upload"); setNotice(null);
    try {
      await cancelHotVideoUpload(savedUpload.id);
      setSavedUpload(null); uploadSession.current = null;
      setNotice({ message: "上次上传进度已取消。已经完整保存的视频会保留在列表。" });
      setReload(value => value + 1);
    } catch (error) { setNotice(failed(error)); }
    finally { setWorking(""); }
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renaming || !renaming.title.trim()) return;
    if (await action(`rename:${renaming.id}`, { action: "update", id: renaming.id, title: renaming.title.trim() }, "视频名称已保存。")) setRenaming(null);
  }
  const targetKnown = status?.candidates?.some(candidate => candidate.chatId === draft.targetChatId) ? draft.targetChatId : "";
  const savedTarget = status?.targetTitle || "🔞365 Free Bonus Hot";
  const usedPercent = status && status.storage.maxBytes > 0 ? Math.min(100, status.storage.bytes / status.storage.maxBytes * 100) : 0;
  const keepNextTime = status?.enabled && draft.targetChatId.trim() === status.targetChatId && draft.intervalHours === status.intervalHours;
  const matchingUpload = savedUpload && file && savedUpload.originalName === file.name && savedUpload.bytes === file.size && savedUpload.lastModified === file.lastModified;

  return <section className="cms-settings-form cms-telegram-settings cms-hot-videos" aria-labelledby="hot-videos-title">
    <div className="cms-settings-panel">
      <div>
        <h2 id="hot-videos-title">Hot 视频发布</h2>
        <p>上传视频后发送到 🔞365 Free Bonus Hot。可立即发布、指定时间，或全天按固定间隔自动轮播。</p>
        <span className={`cms-telegram-status${status?.enabled && status.ready ? " cms-telegram-enabled" : ""}`}>
          {loading && !status ? "读取中" : status?.enabled ? status.ready ? "自动发布已开启" : "需要检查" : "自动发布未开启"}
        </span>
        <p className="cms-hot-videos-timezone"><Clock3 size={13} />马来西亚时间（UTC+8）</p>
      </div>
      <div className="cms-settings-fields cms-hot-videos-fields">
        {notice && <div className={`cms-alert${notice.error ? " cms-error" : " cms-success"}`} role={notice.error ? "alert" : "status"}>
          <span>{notice.message}</span>{notice.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
        </div>}
        <form onSubmit={save} className="cms-hot-videos-config">
          <fieldset disabled={loading || Boolean(busy)}>
            <label className="cms-telegram-switch"><input type="checkbox" role="switch" checked={draft.enabled}
              onChange={event => change({ enabled: event.target.checked })} />启用 Hot 视频自动发布</label>
            <small>仅发送视频和下方三个按钮，不添加文案。使用已保存的 @FreeBonus365ChatBot；机器人需为目标频道管理员并具备发布消息权限。</small>
            {(status?.candidates?.length || 0) > 0 && <label>选择已识别频道<select value={targetKnown}
              onChange={event => change({ targetChatId: event.target.value })}>
              <option value="">选择频道，或在下方填写 ID</option>
              {status?.candidates?.map(candidate => <option key={candidate.chatId} value={candidate.chatId}>{candidate.title} · {candidate.chatId}</option>)}
            </select></label>}
            <label>Hot 频道 ID<input value={draft.targetChatId} required={draft.enabled} maxLength={80} spellCheck={false} autoComplete="off"
              placeholder="例如：-1001234567890" onChange={event => change({ targetChatId: event.target.value })} />
              <small>默认使用上方 Hot 入群限制保存的频道。更改本模块目标不会更改门禁设置。</small></label>
            <div className="cms-hot-videos-config-grid">
              <label>自动发送间隔<select value={draft.intervalHours} onChange={event => change({ intervalHours: Number(event.target.value) })}>
                {[1, 3, 6, 12, 24].map(hours => <option key={hours} value={hours}>每 {hours} 小时一条{hours === 6 ? "（每天 4 条）" : ""}</option>)}
              </select></label>
              <label>重新指定首发时间（可选）<input type="datetime-local" step="60" value={draft.firstRunAt}
                onChange={event => change({ firstRunAt: event.target.value })} />
                <small>{keepNextTime ? "留空保留现有下一次发送时间。" : `留空将在保存启用 ${draft.intervalHours} 小时后首次发送。`}</small></label>
            </div>
            <div className="cms-hot-videos-next"><CalendarClock size={17} /><div><strong>下次自动发送</strong>
              <span>{status?.enabled ? formatTime(status.nextRunAt) : "尚未启用"}</span></div></div>
            <small>按上传顺序轮流发送已启用的视频，发完一轮后继续循环。刷新页面或重启不会重置时间；停机期间错过的时段不会集中补发。立即发送和单次定时不改变自动轮播时间。</small>
            <div className="cms-hot-videos-actions">
              <button className="cms-primary" type="submit">{busy === "save" ? <LoaderCircle size={16} className="cms-spin" /> : <Check size={16} />}保存发布设置</button>
              {dirty && <span className="cms-hot-videos-unsaved">有未保存的设置</span>}
            </div>
          </fieldset>
        </form>

        <div className="cms-hot-videos-button-preview"><strong>每条视频固定附带</strong>
          {buttons.map(button => <a key={button.url} href={button.url} target="_blank" rel="noopener noreferrer">{button.text}<span>{button.url}</span></a>)}
        </div>

        <form className="cms-hot-videos-upload" onSubmit={upload}>
          <div className="cms-hot-videos-heading"><h3><Upload size={17} />添加视频</h3>
            {status && <span>{formatSize(status.storage.bytes)} / {formatSize(status.storage.maxBytes)}</span>}</div>
          {status && <div className="cms-hot-videos-storage" role="meter" aria-label="视频储存空间" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPercent)}>
            <span style={{ width: `${usedPercent}%` }} /></div>}
          <fieldset disabled={loading || Boolean(busy)}>
            <label>视频文件<input key={uploadInputKey} type="file" accept="video/mp4,.mp4" required onChange={event => chooseFile(event.target.files?.[0] || null)} />
              <small>MP4，每个最多 {formatSize(status?.storage.maxVideoBytes || maxVideoBytes)}。连接中断后，重新选择同一个文件可继续已保存的上传进度。</small></label>
            <label>后台名称<input value={uploadTitle} maxLength={120} readOnly={Boolean(matchingUpload)} placeholder="例如：Hot 视频 01" onChange={event => setUploadTitle(event.target.value)} />
              <small>{matchingUpload ? "继续上传沿用原名称；保存完成后可在视频列表重命名。" : "仅用于后台识别，不会作为文案发到频道。"}</small></label>
            {file && <small className="cms-hot-videos-selected"><Film size={14} />{file.name} · {formatSize(file.size)}</small>}
            <button className="cms-secondary" type="submit" disabled={!file}>{busy === "upload" ? <LoaderCircle size={16} className="cms-spin" /> : <Upload size={16} />}{matchingUpload ? "继续上传并保存" : "上传并保存视频"}</button>
          </fieldset>
          {savedUpload && uploadPercent === null && <div className="cms-hot-video-resume"><div><strong>{savedUpload.state === "complete" ? "上次视频已上传，等待核对保存结果" : "检测到未完成的上传"}</strong>
            <small>{savedUpload.originalName} · 已保存 {formatSize(savedUpload.receivedBytes)} / {formatSize(savedUpload.bytes)}。{matchingUpload ? "点击继续上传即可接续。" : "请选择原来的同一个文件继续。"}</small></div>
            <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => void discardUpload()}>取消上次上传</button>
          </div>}
          {uploadPercent !== null && <div className="cms-hot-videos-upload-progress" role="status">
            <progress max="100" value={uploadPercent} aria-label="上传进度" /><span>{uploadPhase === "preparing" ? "正在读取视频…" : uploadPhase === "reconnecting" ? "正在重新连接，已保存的进度会保留…" : uploadPhase === "verifying" ? "上传完成，正在检查并保存…" : `正在上传 ${uploadPercent}%`}</span>
            <button type="button" className="cms-secondary" onClick={() => { cancelRequested.current = true; uploadRef.current?.abort(); }}>取消上传</button>
          </div>}
        </form>

        <div className="cms-hot-videos-library">
          <div className="cms-hot-videos-heading"><h3><Film size={17} />视频列表 <span>{status?.videos.length || 0}</span></h3>
            <button type="button" className="cms-secondary" disabled={Boolean(busy) || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />刷新状态</button></div>
          {loading && !status ? <p className="cms-loading"><LoaderCircle size={16} className="cms-spin" /> 正在读取视频…</p>
            : !status?.videos.length ? <p className="cms-hot-videos-empty">还没有视频。上传后可立即发送、指定时间或开启自动轮播。</p>
              : status.videos.map((video, index) => <article className="cms-hot-video-card" key={video.id}>
                <div className="cms-hot-video-card-header"><div className="cms-hot-video-identity"><span className="cms-hot-video-order">{index + 1}</span><div>
                  <strong>{video.title || video.originalName}</strong><small>{video.originalName} · {formatSize(video.bytes)}</small>
                </div></div><div className="cms-hot-video-tools">
                  <button className="cms-icon-button" type="button" disabled={Boolean(busy)} aria-label={`重命名 ${video.title || video.originalName}`}
                    onClick={() => setRenaming({ id: video.id, title: video.title })}><Pencil size={15} /></button>
                  <button className="cms-icon-button cms-hot-video-delete" type="button" disabled={Boolean(busy)} aria-label={`删除 ${video.title || video.originalName}`}
                    onClick={() => void action(`delete:${video.id}`, { action: "delete", id: video.id }, "视频已删除，对应未发送任务已取消。") }><Trash2 size={15} /></button>
                </div></div>
                {renaming?.id === video.id && <form onSubmit={rename} className="cms-hot-video-rename"><input aria-label="新视频名称" required maxLength={120} value={renaming.title}
                  onChange={event => setRenaming({ id: video.id, title: event.target.value })} disabled={Boolean(busy)} />
                  <button type="submit" className="cms-secondary" disabled={Boolean(busy)}><Check size={14} />保存</button>
                  <button type="button" className="cms-icon-button" aria-label="取消重命名" disabled={Boolean(busy)} onClick={() => setRenaming(null)}><X size={14} /></button></form>}
                <div className="cms-hot-video-meta"><span>上传：{formatTime(video.createdAt)}</span><span>最近发送：{formatTime(video.lastSentAt)}</span></div>
                <label className="cms-telegram-switch"><input type="checkbox" checked={video.active} disabled={Boolean(busy)}
                  onChange={event => void action(`active:${video.id}`, { action: "update", id: video.id, active: event.target.checked }, event.target.checked ? "视频已加入自动轮播。" : "视频已退出自动轮播，仍可手动或定时发送。")} />加入自动轮播</label>
                <div className="cms-hot-video-send"><button className="cms-primary" type="button" disabled={Boolean(busy) || !status.targetChatId || dirty}
                  onClick={() => void send(video, false)}>{busy === `send:${video.id}` ? <LoaderCircle size={15} className="cms-spin" /> : <Play size={15} />}立即发送</button>
                  <div className="cms-hot-video-schedule"><label>指定发送时间（MYT）<input type="datetime-local" step="60" value={scheduledTimes[video.id] || ""} disabled={Boolean(busy)}
                    onChange={event => setScheduledTimes(current => ({ ...current, [video.id]: event.target.value }))} /></label>
                    <button className="cms-secondary" type="button" disabled={Boolean(busy) || !scheduledTimes[video.id] || !status.targetChatId || dirty}
                      onClick={() => void send(video, true)}><CalendarClock size={15} />安排发送</button></div>
                </div>
              </article>)}
        </div>

        <div className="cms-hot-videos-history">
          <div className="cms-hot-videos-heading"><h3>发送记录</h3><small>目标：{savedTarget}</small></div>
          {status?.lastError && <p className="cms-telegram-delivery-error" role="alert">{status.lastError}</p>}
          <dl className="cms-telegram-counts">{Object.entries(status?.counts || {}).map(([key, count]) => <div key={key}><dt>{statusLabels[key] || key}</dt><dd>{count}</dd></div>)}</dl>
          {!status?.jobs.length ? <p className="cms-hot-videos-empty">尚无发送任务。</p> : <ol className="cms-hot-video-jobs">
            {status.jobs.map(job => <li key={job.id}><div className="cms-hot-video-job-main"><strong>{job.title || "视频"}</strong>
              <small>{kindLabels[job.kind]} · {formatTime(job.sentAt || job.runAt)}（MYT）</small>{job.lastError && <p>{job.lastError}</p>}</div>
              <span className={`cms-hot-video-job-status cms-hot-video-job-${job.status}`}>{statusLabels[job.status] || job.status}</span>
              {job.status === "pending" && <button className="cms-secondary" type="button" disabled={Boolean(busy)} onClick={() => void action(`cancel:${job.id}`, { action: "cancel", id: job.id }, "该发送任务已取消。")}>取消任务</button>}
            </li>)}
          </ol>}
          <small>发送结果无法确认的任务会显示“待确认”，不会自动重发，以免频道出现重复视频。</small>
        </div>
      </div>
    </div>
  </section>;
}
