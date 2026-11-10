"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, LoaderCircle } from "lucide-react";

type WelcomeDraft = { enabled: boolean; chatId: string; message: string };
type TelegramConfig = {
  enabled: boolean;
  chatId: string;
  hasToken: boolean;
  promotionMessage: string;
  counts: { pending: number; sending: number; sent: number; failed: number; unknown: number; skipped: number };
  lastError: string;
  welcome: WelcomeDraft & { sent: number; lastPolledAt: number | null; lastError: string };
};
type TelegramDraft = Pick<TelegramConfig, "enabled" | "chatId" | "promotionMessage"> & { token: string; welcome: WelcomeDraft };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };
type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const endpoint = "/api/admin/telegram";
const messageLimit = 2000;
const initialDraft: TelegramDraft = {
  enabled: false, chatId: "", token: "", promotionMessage: "",
  welcome: { enabled: false, chatId: "", message: "" },
};
const deliveryLabels = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", skipped: "已跳过" } as const;
const pollTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function draftFromConfig({ enabled, chatId, promotionMessage, welcome }: TelegramConfig): TelegramDraft {
  return {
    enabled, chatId, promotionMessage, token: "",
    welcome: { enabled: welcome.enabled, chatId: welcome.chatId, message: welcome.message },
  };
}

function requestFailure(error: unknown): Notice {
  return {
    message: error instanceof Error ? error.message : "暂时无法连接，请稍后重试。",
    error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401,
  };
}

export default function TelegramGroupSettings({ request, signInPath }: { request: AdminRequest; signInPath: string }) {
  const [config, setConfig] = useState<TelegramConfig | null>(null);
  const [draft, setDraft] = useState<TelegramDraft>(initialDraft);
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
      setDraft(draftFromConfig(result));
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
    const chatId = draft.chatId.trim();
    const token = draft.token.trim();
    const welcome = { ...draft.welcome, chatId: draft.welcome.chatId.trim(), message: draft.welcome.message.trim() };
    if ((draft.enabled || welcome.enabled) && !config.hasToken && !token) {
      setNotice({ message: "请填写机器人 Token。", error: true });
      return;
    }
    if (draft.enabled && !chatId) {
      setNotice({ message: "请填写品牌通知的发送目标。", error: true });
      return;
    }
    if (welcome.enabled && (!welcome.chatId || !welcome.message)) {
      setNotice({ message: "请填写欢迎消息的群组和文案。", error: true });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await request<TelegramConfig>(endpoint, "PUT", {
        enabled: draft.enabled,
        chatId,
        promotionMessage: draft.promotionMessage.trim(),
        welcome,
        ...(token ? { token } : {}),
      });
      setConfig(result);
      setDraft(draftFromConfig(result));
      setNotice({ message: result.enabled || result.welcome.enabled ? "已保存，启用目标的连接验证通过。" : "Telegram 设置已保存。" });
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
  const welcomeEnabled = Boolean(config?.welcome.enabled && config.hasToken && config.welcome.chatId);
  const welcomeStatus = welcomeEnabled ? "已启用" : config?.welcome.enabled ? "请检查设置" : config?.hasToken ? "已停用" : "未配置";
  const feedback = notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>
    <span>{notice.message}</span>
    {notice.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
  </div>;

  return <form className="cms-settings-form cms-telegram-settings" onSubmit={save}>
    <fieldset disabled={loading || saving}>
      <section className="cms-settings-panel" aria-labelledby="telegram-settings-title">
        <div>
          <h2 id="telegram-settings-title">Telegram 机器人</h2>
          <p>品牌通知和入群欢迎共用同一个机器人。</p>
        </div>
        <div className="cms-settings-fields">
          {loading ? <p className="cms-telegram-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载 Telegram 设置…</p> : config ?
            <label>机器人 Token
              <input type="password" autoComplete="new-password" spellCheck={false} maxLength={160} value={draft.token}
                required={(draft.enabled || draft.welcome.enabled) && !config.hasToken} onChange={event => setDraft({ ...draft, token: event.target.value })} />
              <small>{config.hasToken ? "已保存 Token。留空继续使用，填写新 Token 可更换。" : "填写 BotFather 提供的机器人 Token。"}</small>
            </label> : <>
              {feedback}
              <div><button type="button" className="cms-secondary" onClick={() => setReload(previous => previous + 1)}>重新加载</button></div>
            </>}
        </div>
      </section>
      {!loading && config && <>
        <section className="cms-settings-panel" aria-labelledby="telegram-promotion-title">
          <div>
            <h2 id="telegram-promotion-title">品牌上架通知</h2>
            <p>品牌进入 Update 或 New 时发送通知。启用或更换目标时，已上线的待发推广会跳过。</p>
            <span className={`cms-telegram-status${enabled ? " cms-telegram-enabled" : ""}`}>{connectionStatus}</span>
          </div>
          <div className="cms-settings-fields">
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
              启用品牌通知
            </label>
            <label>通知群组或频道
              <input type="text" autoComplete="off" spellCheck={false} placeholder="https://t.me/name" maxLength={80}
                required={draft.enabled} value={draft.chatId} onChange={event => setDraft({ ...draft, chatId: event.target.value })} />
              <small>可填写公开 t.me 链接、@用户名或负数 Chat ID。</small>
              <small>机器人需有群组发言权限，或频道管理员发布权限。</small>
            </label>
            <label>品牌通知文案
              <textarea rows={4} maxLength={messageLimit} value={draft.promotionMessage} placeholder="留空使用默认通知文案"
                onChange={event => setDraft({ ...draft, promotionMessage: event.target.value })} />
              <small>可用 {"{category}、{name}、{tagline}、{link}"}。留空使用默认文案。</small>
              <small>替换变量后超过 1,024 个字符时发送纯文本。</small>
              <small>{draft.promotionMessage.length} / {messageLimit}</small>
            </label>
            <dl className="cms-telegram-counts" aria-label="品牌通知记录">
              {Object.entries(deliveryLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{config.counts[key as keyof TelegramConfig["counts"]]}</dd></div>)}
            </dl>
            {config.lastError && <p className="cms-telegram-last-error">最近发送异常 · {config.lastError}</p>}
          </div>
        </section>
        <section className="cms-settings-panel" aria-labelledby="telegram-welcome-title">
          <div>
            <h2 id="telegram-welcome-title">入群欢迎消息</h2>
            <p>有新成员加入时，机器人会在指定群组内发送欢迎消息。</p>
            <span className={`cms-telegram-status${welcomeEnabled ? " cms-telegram-enabled" : ""}`}>{welcomeStatus}</span>
          </div>
          <div className="cms-settings-fields">
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.welcome.enabled}
                onChange={event => setDraft({ ...draft, welcome: { ...draft.welcome, enabled: event.target.checked } })} />
              启用入群欢迎
            </label>
            <label>欢迎消息群组
              <input type="text" autoComplete="off" spellCheck={false} placeholder="https://t.me/groupname" maxLength={80}
                required={draft.welcome.enabled} value={draft.welcome.chatId}
                onChange={event => setDraft({ ...draft, welcome: { ...draft.welcome, chatId: event.target.value } })} />
              <small>填写群组公开链接、@用户名或负数 Chat ID，并将机器人设为群管理员。</small>
              <small>启用入群欢迎时，请停用该机器人在其他服务的 Webhook 或轮询。</small>
            </label>
            <label>欢迎消息文案
              <textarea rows={4} maxLength={messageLimit} required={draft.welcome.enabled} value={draft.welcome.message}
                placeholder="欢迎 {name} 加入 {group}！"
                onChange={event => setDraft({ ...draft, welcome: { ...draft.welcome, message: event.target.value } })} />
              <small>纯文本。{"{name}"} 会替换为成员名称，{"{group}"} 会替换为群组名称。</small>
              <small>{draft.welcome.message.length} / {messageLimit}</small>
            </label>
            <dl className="cms-telegram-counts" aria-label="入群欢迎记录">
              <div><dt>已发送</dt><dd>{config.welcome.sent}</dd></div>
              <div><dt>最近检查（MYT）</dt><dd>{config.welcome.lastPolledAt === null ? "尚未检查" : pollTimeFormat.format(config.welcome.lastPolledAt)}</dd></div>
            </dl>
            {config.welcome.lastError && <p className="cms-telegram-last-error">最近欢迎消息异常 · {config.welcome.lastError}</p>}
          </div>
        </section>
        <div className="cms-settings-fields">
          {feedback}
          <div className="cms-settings-save">
            <span>保存时会验证已启用的机器人和发送目标。</span>
            <div className="cms-telegram-delivery">
              <button className="cms-secondary" type="button" disabled={refreshing} onClick={refreshStatus}>
                {refreshing && <LoaderCircle size={15} className="cms-spin" />}{refreshing ? "正在刷新…" : "刷新运行状态"}
              </button>
              <button className="cms-primary" type="submit" disabled={refreshing}>{saving ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}{saving ? "正在保存…" : "保存 Telegram 设置"}</button>
            </div>
          </div>
        </div>
      </>}
    </fieldset>
  </form>;
}
