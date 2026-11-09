"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";

type TelegramConfig = {
  enabled: boolean;
  chatId: string;
  hasToken: boolean;
  counts: { pending: number; sending: number; sent: number; failed: number; unknown: number; skipped: number };
  lastError: string;
};
type TelegramDraft = Pick<TelegramConfig, "enabled" | "chatId"> & { token: string };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };
type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const endpoint = "/api/admin/telegram";
const deliveryLabels = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", skipped: "已跳过" } as const;

function requestFailure(error: unknown): Notice {
  return {
    message: error instanceof Error ? error.message : "暂时无法连接，请稍后重试。",
    error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401,
  };
}

export default function TelegramGroupSettings({ request, signInPath }: { request: AdminRequest; signInPath: string }) {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [draft, setDraft] = useState<TelegramDraft>({ enabled: false, chatId: "", token: "" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    request<TelegramConfig>(endpoint).then(result => {
      if (!active) return;
      setConfig(result);
      setDraft({ enabled: result.enabled, chatId: result.chatId, token: "" });
    }).catch(error => {
      if (active) setNotice(requestFailure(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, reload]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!config || loading || saving || refreshing) return;
    setSaving(true);
    setNotice(null);
    const chatId = draft.chatId.trim();
    const token = draft.token.trim();
    try {
      const result = await request<TelegramConfig>(endpoint, "PUT", { enabled: draft.enabled, chatId, ...(token ? { token } : {}) });
      setConfig(result);
      setDraft({ enabled: result.enabled, chatId: result.chatId, token: "" });
      setNotice({ message: result.enabled ? "已保存，机器人与群组连接验证通过。" : "Telegram 群通知设置已保存。" });
    } catch (error) {
      setNotice(requestFailure(error));
    } finally {
      setSaving(false);
    }
  }

  async function refreshStatus() {
    if (loading || saving || refreshing) return;
    setRefreshing(true);
    setNotice(null);
    try {
      setConfig(await request<TelegramConfig>(endpoint));
    } catch (error) {
      setNotice(requestFailure(error));
    } finally {
      setRefreshing(false);
    }
  }

  const enabled = Boolean(config?.enabled && config.hasToken && config.chatId);
  const connectionStatus = enabled ? "已启用" : config?.enabled ? "请检查设置" : config?.hasToken ? "已停用" : "未配置";

  return <form className="cms-settings-form cms-telegram-settings" onSubmit={save}>
    <fieldset disabled={loading || saving}>
      <section className="cms-settings-panel" aria-labelledby="telegram-settings-title">
        <div>
          <h2 id="telegram-settings-title">Telegram 群通知</h2>
          <p>品牌进入 Update 或 New 时，发送通知到指定群组。启用或切换群组时跳过已上线的待发推广。</p>
          {config && <span className={`cms-telegram-status${enabled ? " cms-telegram-enabled" : ""}`}>{connectionStatus}</span>}
        </div>
        <div className="cms-settings-fields">
          {notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>
            <span>{notice.message}</span>
            {notice.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
          </div>}
          {loading ? <p className="cms-telegram-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载群通知设置…</p> : config ? <>
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
              启用 Telegram 群通知
            </label>
            <label>Telegram 群组 ID
              <input type="text" autoComplete="off" spellCheck={false} placeholder="-100… 或 @群组名称" maxLength={40}
                required={draft.enabled} value={draft.chatId} onChange={event => setDraft({ ...draft, chatId: event.target.value })} />
              <small>请先将机器人加入群组，并允许它发送消息。</small>
            </label>
            <label>机器人 Token
              <input type="password" autoComplete="new-password" spellCheck={false} maxLength={160} value={draft.token}
                required={draft.enabled && !config.hasToken} onChange={event => setDraft({ ...draft, token: event.target.value })} />
              <small>{config.hasToken ? "已保存 Token。留空继续使用，填写新 Token 可更换。" : "填写 BotFather 提供的机器人 Token。"}</small>
            </label>
            <div className="cms-telegram-delivery">
              <dl className="cms-telegram-counts" aria-label="Telegram 通知记录">
                {Object.entries(deliveryLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{config.counts[key as keyof TelegramConfig["counts"]]}</dd></div>)}
              </dl>
              <button className="cms-secondary" type="button" disabled={refreshing} onClick={refreshStatus}>
                {refreshing && <LoaderCircle size={15} className="cms-spin" />}{refreshing ? "正在刷新…" : "刷新发送状态"}
              </button>
            </div>
            {config.lastError && <p className="cms-telegram-last-error">最近发送异常 · {config.lastError}</p>}
            <div className="cms-settings-save">
              <span>启用后保存，将核验机器人与群组连接。</span>
              <button className="cms-primary" type="submit" disabled={refreshing}>{saving ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}{saving ? "正在保存…" : "保存群通知设置"}</button>
            </div>
          </> : <div><button type="button" className="cms-secondary" onClick={() => setReload(previous => previous + 1)}>重新加载</button></div>}
        </div>
      </section>
    </fieldset>
  </form>;
}
