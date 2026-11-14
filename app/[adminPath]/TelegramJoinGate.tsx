"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import "./telegram-join-gate-admin.css";

type Requirement = { chatId: string; label: string; url: string };
type GateDraft = { enabled: boolean; targetChatId: string; requiredChats: Requirement[]; revision?: string };
type GateStatus = GateDraft & {
  targetTitle: string;
  inviteLink: string;
  ready: boolean;
  lastError: string;
  lastCheckedAt: number | null;
  counts: { pending: number; approved: number; blocked: number; failed: number; unknown: number };
  candidates: { chatId: string; title: string }[];
};
type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = { request: AdminRequest; signInPath: string };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };

const endpoint = "/api/admin/telegram/gate";
const botEntry = "https://t.me/FreeBonus365ChatBot?start=hot";
const defaults: Requirement[] = [
  { chatId: "@join365freebonus", label: "🎁 BONUS OFFICIAL", url: "https://t.me/join365freebonus" },
  { chatId: "@join365freebonusgroup", label: "🎁 BONUS GROUP", url: "https://t.me/join365freebonusgroup" },
];
const labels = { pending: "待检查", approved: "已批准", blocked: "已限制", failed: "检查失败", unknown: "待确认" } as const;
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function toDraft(status: GateStatus): GateDraft {
  return {
    enabled: status.enabled, targetChatId: status.targetChatId || "", revision: status.revision,
    requiredChats: (status.requiredChats.length ? status.requiredChats : defaults).map(rule => ({ ...rule })),
  };
}
function errorNotice(error: unknown): Notice {
  return {
    message: error instanceof Error ? error.message : "暂时无法读取或保存，请稍后重试。", error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401,
  };
}
function publicUsername(value: string): string {
  const match = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(value.trim());
  return match ? `@${match[1]}` : "";
}

export default function TelegramJoinGate({ request, signInPath }: Props) {
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [draft, setDraft] = useState<GateDraft>({ enabled: false, targetChatId: "", requiredChats: defaults.map(rule => ({ ...rule })) });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void request<GateStatus>(endpoint).then(value => {
      if (!active) return;
      setStatus(value);
      if (!dirtyRef.current) setDraft(toDraft(value));
    }).catch(error => { if (active) setNotice(errorNotice(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, reload]);

  function change(next: GateDraft) {
    dirtyRef.current = true; setDirty(true); setDraft(next); setNotice(null);
  }
  function changeRule(index: number, patch: Partial<Requirement>) {
    change({ ...draft, requiredChats: draft.requiredChats.map((rule, position) => position === index ? { ...rule, ...patch } : rule) });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading) return;
    setSaving(true); setNotice(null);
    try {
      const value = await request<GateStatus>(endpoint, "PUT", draft);
      setStatus(value); setDraft(toDraft(value)); dirtyRef.current = false; setDirty(false);
      setNotice({ message: value.enabled ? (value.ready ? "Hot 入群限制已验证并启用。" : "设置已保存，请查看下方运行状态和异常提示。") : "设置已保存，Hot 入群限制未启用。" });
    } catch (error) { setNotice(errorNotice(error)); }
    finally { setSaving(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice({ message: "链接已复制。" }); }
    catch { setNotice({ message: "未能自动复制，请选择下方链接后手动复制。", error: true }); }
  }
  function refresh() {
    setNotice({ message: dirtyRef.current ? "正在刷新频道列表和运行状态，未保存的设置会保留。" : "正在刷新频道列表和运行状态。" });
    setReload(value => value + 1);
  }
  const stateLabel = !status?.enabled ? "未启用" : status.ready ? "已验证并启用" : "需要检查";
  const knownTarget = status?.candidates.some(candidate => candidate.chatId === draft.targetChatId) ? draft.targetChatId : "";
  const safeInvite = status?.inviteLink && /^https:\/\/t\.me\/(?:\+[A-Za-z0-9_-]+|joinchat\/[A-Za-z0-9_-]+)$/.test(status.inviteLink) ? status.inviteLink : "";

  return <section className="cms-settings-form cms-telegram-settings cms-telegram-gate" aria-labelledby="telegram-gate-title">
    <div className="cms-settings-panel">
      <div>
        <h2 id="telegram-gate-title">Hot 入群限制</h2>
        <p>顾客必须加入下面所有频道或群组，才会获批进入 Hot。退出其中一个后，系统复查并取消 Hot 访问。</p>
        <span className={`cms-telegram-status${status?.enabled && status.ready ? " cms-telegram-enabled" : ""}`}>{stateLabel}</span>
      </div>
      <form className="cms-settings-fields" onSubmit={save}>
        {notice && <div className={`cms-alert${notice.error ? " cms-error" : " cms-success"}`} role={notice.error ? "alert" : "status"}>
          <span>{notice.message}</span>{notice.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
        </div>}
        <fieldset disabled={saving || loading} className="cms-telegram-gate-fieldset">
          <label className="cms-telegram-switch">
            <input type="checkbox" role="switch" checked={draft.enabled} onChange={event => change({ ...draft, enabled: event.target.checked })} />
            启用 Hot 入群限制
          </label>
          <small>使用上方已保存的 @FreeBonus365ChatBot。请先开启并保存“1 对 1 私聊”。</small>
          <label>选择 Hot 私密频道
            <select value={knownTarget} onChange={event => change({ ...draft, targetChatId: event.target.value })}>
              <option value="">请选择已识别的频道，或在下方填写 ID</option>
              {(status?.candidates || []).map(candidate => <option key={candidate.chatId} value={candidate.chatId}>{candidate.title || "未命名频道"} · {candidate.chatId}</option>)}
            </select>
          </label>
          <small>将 ChatBot 设为 Hot 管理员后，在 Hot 发布一条普通消息，或向 ChatBot 转发一条 Hot 消息，再点击“刷新频道和状态”。禁止转发时，请在 Hot 内发布消息。</small>
          <label>Hot 频道 ID
            <input value={draft.targetChatId} maxLength={80} required={draft.enabled} autoComplete="off" spellCheck={false} placeholder="例如：-1001234567890"
              onChange={event => change({ ...draft, targetChatId: event.target.value })} />
            <small>Hot 需设为 Private，ChatBot 需具备邀请／审批成员及封禁成员权限。保存启用时会核实频道身份与权限。</small>
          </label>
          {status?.targetTitle && <small>当前保存目标：{status.targetTitle}</small>}
          <div className="cms-telegram-gate-requirements">
            <div className="cms-telegram-gate-heading"><strong>必须加入的频道／群组</strong>
              <button type="button" className="cms-secondary" disabled={draft.requiredChats.length >= 8}
                onClick={() => change({ ...draft, requiredChats: [...draft.requiredChats, { chatId: "", label: "", url: "" }] })}><Plus size={15} />添加条件</button>
            </div>
            <small>以下条件需要全部满足。名称用于显示给顾客；邀请链接里的 Link Name 只是备注，不会建立这些加入条件。</small>
            {draft.requiredChats.map((rule, index) => <div className="cms-telegram-gate-rule" key={index}>
              <div className="cms-telegram-gate-heading"><strong>加入条件 {index + 1}</strong>
                <button type="button" className="cms-icon-button" aria-label={`删除加入条件 ${index + 1}`} disabled={draft.requiredChats.length <= 1}
                  onClick={() => change({ ...draft, requiredChats: draft.requiredChats.filter((_, position) => position !== index) })}><Trash2 size={16} /></button>
              </div>
              <label>顾客看到的名称<input value={rule.label} maxLength={80} required={draft.enabled} onChange={event => changeRule(index, { label: event.target.value })} /></label>
              <label>公开 Telegram 链接<input type="url" value={rule.url} maxLength={160} required={draft.enabled} autoComplete="off" placeholder="https://t.me/频道用户名"
                onChange={event => { const url = event.target.value; const chatId = publicUsername(url); changeRule(index, { url, ...(chatId ? { chatId } : {}) }); }} /></label>
              <label>频道 ID／@用户名<input value={rule.chatId} maxLength={160} required={draft.enabled} autoComplete="off" spellCheck={false}
                onChange={event => changeRule(index, { chatId: event.target.value })} /><small>填写公开链接时会自动带入 @用户名；仅在需要时手动调整。</small></label>
            </div>)}
          </div>
          <div className="cms-telegram-gate-actions">
            <button type="button" className="cms-secondary" onClick={refresh}><RefreshCw size={15} />刷新频道和状态</button>
            <button type="submit" className="cms-primary">{saving ? <LoaderCircle size={16} className="cms-spin" /> : <Check size={16} />}{saving ? "正在验证并保存…" : draft.enabled ? "验证并保存设置" : "保存设置"}</button>
          </div>
          {dirty && <small>修改尚未保存；上方状态显示当前已保存的设置。</small>}
        </fieldset>
        {loading && <p role="status" className="cms-telegram-loading"><LoaderCircle size={16} className="cms-spin" />正在读取入群限制设置…</p>}
        {!loading && !status && <button type="button" className="cms-secondary" onClick={refresh}>重新读取设置</button>}
        {status && <div className="cms-telegram-gate-runtime">
          <dl className="cms-telegram-counts" aria-label="Hot 入群验证状态">
            {Object.entries(labels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{status.counts[key as keyof GateStatus["counts"]] || 0}</dd></div>)}
          </dl>
          <small>最近检查（马来西亚时间）：{status.lastCheckedAt ? timeFormat.format(new Date(status.lastCheckedAt)) : "尚未检查"}</small>
          {status.lastError && <p className="cms-telegram-last-error">最近入群验证异常 · {status.lastError}</p>}
          {status.enabled && status.ready && <div className="cms-telegram-gate-links">
            <label>顾客验证入口<input readOnly value={botEntry} onFocus={event => event.currentTarget.select()} /></label>
            <div className="cms-telegram-gate-actions"><a className="cms-secondary" href={botEntry} target="_blank" rel="noopener noreferrer">打开机器人入口 ↗</a>
              <button type="button" className="cms-secondary" onClick={() => void copy(botEntry)}><Copy size={15} />复制验证入口</button></div>
            {safeInvite && <><label>机器人创建的 Hot 审批邀请<input readOnly value={safeInvite} onFocus={event => event.currentTarget.select()} /></label>
              <button type="button" className="cms-secondary" onClick={() => void copy(safeInvite)}><Copy size={15} />复制审批邀请</button></>}
          </div>}
        </div>}
        <div className="cms-telegram-gate-notes">
          <p>对外使用机器人验证入口或本功能创建的审批邀请。可直接加入的 Primary link、其他直入邀请或管理员手动批准，可能绕过加入前的验证。</p>
          <p>系统处理启用后的新申请，并复查本功能已纳管的成员；不会自动批量移除历史成员。退出检测结合成员变化与周期复核，可能有延迟。</p>
          <p>网络错误或机器人权限不足不会被当成“没有加入”。无法确认时暂停审批及移除，并保留异常提示；关闭功能后不再处理旧任务。</p>
        </div>
      </form>
    </div>
  </section>;
}
