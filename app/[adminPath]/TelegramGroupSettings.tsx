"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import "./telegram-keywords-admin.css";

type WelcomeDraft = { enabled: boolean; chatId: string; message: string };
type FollowupPreferences = { enabled: boolean; message: string };
type FollowupStatus = FollowupPreferences & {
  delayMinutes: 60;
  counts: { pending: number; sent: number; failed: number; unknown: number; cancelled: number };
  lastError: string;
};
type ChatBotPreferences = { keywordEnabled: boolean; privateEnabled: boolean; privateStartMessage: string; followup: FollowupPreferences };
type TelegramConfig = {
  enabled: boolean;
  chatId: string;
  hasToken: boolean;
  promotionMessage: string;
  counts: { pending: number; sending: number; sent: number; failed: number; unknown: number; skipped: number };
  lastError: string;
  welcome: WelcomeDraft & { sent: number; lastPolledAt: number | null; lastError: string };
  chatBot: Omit<ChatBotPreferences, "followup"> & { hasToken: boolean; keywordReplies: number; privateReplies: number; followup: FollowupStatus };
};
type TelegramDraft = Pick<TelegramConfig, "enabled" | "chatId" | "promotionMessage"> & {
  token: string;
  welcome: WelcomeDraft;
  chatBot: ChatBotPreferences & { token: string };
};
type KeywordRule = { id: number; keyword: string; matchMode: "exact" | "contains"; response: string; showButton: boolean };
type KeywordDraft = Omit<KeywordRule, "id"> & { id?: number };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };
type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type AdminProps = { request: AdminRequest; signInPath: string };

const endpoint = "/api/admin/telegram";
const keywordsEndpoint = `${endpoint}/keywords`;
const privateStartUrl = "https://t.me/FreeBonus365ChatBot?start=welcome";
const keywordLimit = 120;
const messageLimit = 2000;
const initialDraft: TelegramDraft = {
  enabled: false, chatId: "", token: "", promotionMessage: "",
  welcome: { enabled: false, chatId: "", message: "" },
  chatBot: { token: "", keywordEnabled: false, privateEnabled: false, privateStartMessage: "", followup: { enabled: false, message: "" } },
};
const initialKeyword: KeywordDraft = { keyword: "", matchMode: "exact", response: "", showButton: true };
const keywordModes = [
  { showButton: true, title: "按键关键字", description: "显示在 1 对 1 私聊菜单，顾客点击按键或输入关键字都能获得回复。", add: "添加按键关键字", empty: "尚未添加按键关键字。" },
  { showButton: false, title: "文字关键字（不显示按键）", description: "只根据顾客输入的关键字回复，不显示为菜单按键，回复也不附带按键。", add: "添加文字关键字", empty: "尚未添加文字关键字。" },
] as const;
const matchLabels = { exact: "完全匹配", contains: "包含关键词" } as const;
const deliveryLabels = { pending: "待发送", sending: "发送中", sent: "已发送", failed: "发送失败", unknown: "待确认", skipped: "已跳过" } as const;
const followupLabels = { pending: "待跟进", sent: "已发送", failed: "发送失败", unknown: "待确认", cancelled: "无需跟进 / 已取消" } as const;
const pollTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function draftFromConfig({ enabled, chatId, promotionMessage, welcome, chatBot }: TelegramConfig): TelegramDraft {
  return {
    enabled, chatId, promotionMessage, token: "",
    welcome: { enabled: welcome.enabled, chatId: welcome.chatId, message: welcome.message },
    chatBot: {
      token: "", keywordEnabled: chatBot.keywordEnabled,
      privateEnabled: chatBot.privateEnabled, privateStartMessage: chatBot.privateStartMessage,
      followup: { enabled: chatBot.followup?.enabled ?? false, message: chatBot.followup?.message ?? "" },
    },
  };
}

function requestFailure(error: unknown): Notice {
  return {
    message: error instanceof Error ? error.message : "暂时无法连接，请稍后重试。",
    error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401,
  };
}

function TelegramNotice({ notice, signInPath }: { notice: Notice | null; signInPath: string }) {
  if (!notice) return null;
  return <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>
    <span>{notice.message}</span>
    {notice.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
  </div>;
}

function TelegramKeywordRules({ request, signInPath }: AdminProps) {
  const [rules, setRules] = useState<KeywordRule[] | null>(null);
  const [editing, setEditing] = useState<KeywordDraft | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const editorRef = useRef<HTMLFormElement>(null);
  const editorOpen = Boolean(editing);

  useEffect(() => {
    if (!editorOpen) return;
    editorRef.current?.scrollIntoView({ block: "nearest" });
    editorRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [editorOpen, editing?.id]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotice(null);
    request<{ rules: KeywordRule[] }>(keywordsEndpoint).then(result => {
      if (active) setRules(result.rules.map(rule => ({ ...rule, showButton: rule.showButton !== false })));
    }).catch(error => {
      if (active) setNotice(requestFailure(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, reload]);

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    const { id, matchMode, showButton } = editing;
    const keyword = editing.keyword.trim();
    const response = editing.response.trim();
    if (!keyword || !response) {
      setNotice({ message: "请填写关键词和回复文案。", error: true });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const payload = { keyword, matchMode, response, showButton };
      const result = await request<{ rule: KeywordRule }>(keywordsEndpoint, id === undefined ? "POST" : "PUT",
        id === undefined ? payload : { id, ...payload });
      setRules(current => {
        const list = current ?? [];
        return id === undefined ? [...list, result.rule] : list.map(rule => rule.id === id ? result.rule : rule);
      });
      setEditing(null);
      setNotice({ message: showButton ? "按键关键字已保存。在 Telegram 发送 /menu 可查看最新按键。" : "文字关键字已保存，顾客输入匹配内容后会自动回复。" });
    } catch (error) {
      setNotice(requestFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(rule: KeywordRule) {
    if (busy || !window.confirm(`删除关键词规则「${rule.keyword}」？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const { id } = await request<{ id: number }>(keywordsEndpoint, "DELETE", { id: rule.id });
      setRules(current => current?.filter(item => item.id !== id) ?? []);
      setNotice({ message: "关键词规则已删除。" });
    } catch (error) {
      setNotice(requestFailure(error));
    } finally {
      setBusy(false);
    }
  }

  function openRule(rule: KeywordDraft) {
    setNotice(null);
    setEditing({ ...rule });
  }

  return <section className="cms-settings-form cms-telegram-settings cms-telegram-keywords" aria-labelledby="telegram-keywords-title">
    <div className="cms-settings-panel">
      <div>
        <h2 id="telegram-keywords-title">关键词回复规则</h2>
        <p>按键与文字规则分开管理。两类规则都支持群组和私聊文字匹配，显示按键的设置仅用于 1 对 1 私聊菜单。</p>
      </div>
      <div className="cms-settings-fields">
        <TelegramNotice notice={notice} signInPath={signInPath} />
        {loading ? <p className="cms-telegram-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载关键词规则…</p> : rules === null ?
          <div><button type="button" className="cms-secondary" onClick={() => setReload(previous => previous + 1)}>重新加载规则</button></div> : <>
            {editing && <form ref={editorRef} className="cms-settings-form cms-telegram-keyword-editor" onSubmit={saveRule}>
              <fieldset className="cms-settings-fields" disabled={busy}>
                <h3>{editing.id === undefined ? (editing.showButton ? "添加按键关键字" : "添加文字关键字") : "编辑关键词规则"}</h3>
                <label>显示方式
                  <select value={editing.showButton ? "button" : "text"}
                    onChange={event => setEditing({ ...editing, showButton: event.target.value === "button" })}>
                    <option value="button">按键关键字</option>
                    <option value="text">文字关键字（不显示按键）</option>
                  </select>
                  <small>更改显示方式后，保存即可将规则移到对应分类；文字匹配方式保持独立。</small>
                </label>
                <div className="cms-form-grid">
                  <label>关键词
                    <input required maxLength={keywordLimit} value={editing.keyword} placeholder="例如 bonus"
                      onChange={event => setEditing({ ...editing, keyword: event.target.value })} />
                  </label>
                  <label>匹配方式
                    <select value={editing.matchMode} onChange={event => setEditing({ ...editing, matchMode: event.target.value as KeywordRule["matchMode"] })}>
                      {Object.entries(matchLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                </div>
                <label>回复文案
                  <textarea required rows={4} maxLength={messageLimit} value={editing.response}
                    onChange={event => setEditing({ ...editing, response: event.target.value })} />
                  <small>{editing.response.length} / {messageLimit}</small>
                </label>
                <div className="cms-telegram-delivery">
                  <button className="cms-primary" type="submit">{busy ? <LoaderCircle size={16} className="cms-spin" /> : <Check size={16} />}{busy ? "正在保存…" : "保存规则"}</button>
                  <button className="cms-secondary" type="button" onClick={() => setEditing(null)}>取消</button>
                </div>
              </fieldset>
            </form>}
            <div className="cms-telegram-keyword-groups">
              {keywordModes.map(mode => {
                const groupedRules = rules.filter(rule => rule.showButton === mode.showButton);
                const groupId = mode.showButton ? "telegram-button-keywords" : "telegram-text-keywords";
                return <section className="cms-telegram-keyword-group" key={groupId} aria-labelledby={groupId}>
                  <div className="cms-telegram-keyword-group-heading">
                    <div><h3 id={groupId}>{mode.title}<span className="cms-telegram-keyword-count">{groupedRules.length}</span></h3><p>{mode.description}</p></div>
                    <button type="button" className="cms-secondary" disabled={busy || Boolean(editing)}
                      onClick={() => openRule({ ...initialKeyword, showButton: mode.showButton })}><Plus size={16} />{mode.add}</button>
                  </div>
                  {groupedRules.length ? <ul className="cms-brand-panel cms-telegram-keyword-list">
                    {groupedRules.map(rule => <li key={rule.id}>
                      <div className="cms-telegram-keyword-summary">
                        <strong>{rule.keyword}</strong>
                        <small>{matchLabels[rule.matchMode]}</small>
                        <p>{rule.response}</p>
                      </div>
                      <div className="cms-row-actions">
                        <button type="button" disabled={busy || Boolean(editing)} aria-label={`编辑规则 ${rule.keyword}`} onClick={() => openRule(rule)}><Pencil size={15} /></button>
                        <button type="button" className="cms-delete" disabled={busy || Boolean(editing)} aria-label={`删除规则 ${rule.keyword}`} onClick={() => void deleteRule(rule)}><Trash2 size={15} /></button>
                      </div>
                    </li>)}
                  </ul> : <p className="cms-telegram-keyword-empty">{mode.empty}</p>}
                </section>;
              })}
            </div>
          </>}
      </div>
    </div>
  </section>;
}

export default function TelegramGroupSettings({ request, signInPath }: AdminProps) {
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
    const { token: chatTokenInput, keywordEnabled, privateEnabled, privateStartMessage, followup } = draft.chatBot;
    const chatToken = chatTokenInput.trim();
    const welcome = { ...draft.welcome, chatId: draft.welcome.chatId.trim(), message: draft.welcome.message.trim() };
    const targetRequired = welcome.enabled || keywordEnabled;
    if (draft.enabled && !config.hasToken && !token) {
      setNotice({ message: "请填写 @FreeBonus365Bot 的 Token。", error: true });
      return;
    }
    if (draft.enabled && !chatId) {
      setNotice({ message: "请填写品牌通知的发送目标。", error: true });
      return;
    }
    if ((targetRequired || privateEnabled) && !config.chatBot.hasToken && !chatToken) {
      setNotice({ message: "请填写 @FreeBonus365ChatBot 的 Token。", error: true });
      return;
    }
    if (targetRequired && !welcome.chatId) {
      setNotice({ message: "请填写聊天机器人的群组或频道目标。", error: true });
      return;
    }
    if (welcome.enabled && !welcome.message) {
      setNotice({ message: "请填写入群欢迎文案。", error: true });
      return;
    }
    if (followup.enabled && !privateEnabled) {
      setNotice({ message: "请先启用 1 对 1 私聊，再开启未识别消息自动跟进。", error: true });
      return;
    }
    if (followup.enabled && !followup.message.trim()) {
      setNotice({ message: "请填写未识别消息的自动跟进文案。", error: true });
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
        chatBot: {
          keywordEnabled, privateEnabled, privateStartMessage: privateStartMessage.trim(),
          followup: { enabled: followup.enabled, message: followup.message.trim() },
          ...(chatToken ? { token: chatToken } : {}),
        },
        ...(token ? { token } : {}),
      });
      setConfig(result);
      setDraft(draftFromConfig(result));
      setNotice({ message: "Telegram 设置已保存。" });
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
  const savedTargetRequired = Boolean(config?.welcome.enabled || config?.chatBot.keywordEnabled);
  const chatRequested = savedTargetRequired || Boolean(config?.chatBot.privateEnabled);
  const chatEnabled = Boolean(chatRequested && config?.chatBot.hasToken && (!savedTargetRequired || config.welcome.chatId));
  const chatStatus = chatEnabled ? "已启用" : chatRequested ? "请检查设置" : config?.chatBot.hasToken ? "已停用" : "未配置";
  const targetRequired = draft.welcome.enabled || draft.chatBot.keywordEnabled;
  const chatTokenRequired = targetRequired || draft.chatBot.privateEnabled;
  const feedback = <TelegramNotice notice={notice} signInPath={signInPath} />;

  return <><form className="cms-settings-form cms-telegram-settings" onSubmit={save}>
    <fieldset disabled={loading || saving}>
      {(loading || !config) && <section className="cms-settings-panel" aria-labelledby="telegram-settings-title">
        <div>
          <h2 id="telegram-settings-title">Telegram 机器人设置</h2>
        </div>
        <div className="cms-settings-fields">
          {loading ? <p className="cms-telegram-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载 Telegram 设置…</p> : <>
            {feedback}
            <div><button type="button" className="cms-secondary" onClick={() => setReload(previous => previous + 1)}>重新加载</button></div>
          </>}
        </div>
      </section>}
      {!loading && config && <>
        <section className="cms-settings-panel" aria-labelledby="telegram-promotion-title">
          <div>
            <h2 id="telegram-promotion-title">通知机器人</h2>
            <p>品牌进入 Update 或 New 时发送通知。启用或更换目标时，已上线的待发推广会跳过。</p>
            <span className={`cms-telegram-status${enabled ? " cms-telegram-enabled" : ""}`}>{connectionStatus}</span>
          </div>
          <div className="cms-settings-fields">
            <label>@FreeBonus365Bot Token（Update / New）
              <input type="password" autoComplete="new-password" spellCheck={false} maxLength={160} value={draft.token}
                required={draft.enabled && !config.hasToken} onChange={event => setDraft({ ...draft, token: event.target.value })} />
              <small>{config.hasToken ? "已保存通知机器人的 Token。留空继续使用。" : "填写 BotFather 提供的 @FreeBonus365Bot Token。"}</small>
            </label>
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
            <h2 id="telegram-welcome-title">聊天机器人</h2>
            <p>管理加入欢迎、群组关键词回复和 1 对 1 私聊。只有加入欢迎或群组回复需要设置目标。</p>
            <span className={`cms-telegram-status${chatEnabled ? " cms-telegram-enabled" : ""}`}>{chatStatus}</span>
          </div>
          <div className="cms-settings-fields">
            <label>@FreeBonus365ChatBot Token（欢迎、关键词、私聊）
              <input type="password" autoComplete="new-password" spellCheck={false} maxLength={160} value={draft.chatBot.token}
                required={chatTokenRequired && !config.chatBot.hasToken}
                onChange={event => setDraft({ ...draft, chatBot: { ...draft.chatBot, token: event.target.value } })} />
              <small>{config.chatBot.hasToken ? "已保存聊天机器人的 Token。留空继续使用。" : "填写 BotFather 提供的 @FreeBonus365ChatBot Token。"}</small>
            </label>
            <label>加入欢迎与群组回复目标
              <input type="text" autoComplete="off" spellCheck={false} placeholder="https://t.me/groupname" maxLength={80}
                required={targetRequired} value={draft.welcome.chatId}
                onChange={event => setDraft({ ...draft, welcome: { ...draft.welcome, chatId: event.target.value } })} />
              <small>填写公开链接、@用户名或负数 Chat ID，并将机器人设为目标管理员。</small>
              <small>开启私聊且关闭群组关键词回复时，加入欢迎也支持频道。</small>
              <small>启用聊天机器人前，请停用它在其他服务的 Webhook 或轮询。</small>
            </label>
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.welcome.enabled}
                onChange={event => setDraft({ ...draft, welcome: { ...draft.welcome, enabled: event.target.checked } })} />
              启用入群欢迎
            </label>
            <label>欢迎消息文案
              <textarea rows={4} maxLength={messageLimit} required={draft.welcome.enabled} value={draft.welcome.message}
                placeholder="欢迎 {name} 加入 {group}！"
                onChange={event => setDraft({ ...draft, welcome: { ...draft.welcome, message: event.target.value } })} />
              <small>纯文本。{"{name}"} 会替换为成员名称，{"{group}"} 会替换为群组名称。</small>
              <small>开启私聊后，先给机器人发过消息的用户加入时会收到私聊欢迎。其他群组新成员会看到 Start 链接。</small>
              <small>{draft.welcome.message.length} / {messageLimit}</small>
            </label>
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.chatBot.keywordEnabled}
                onChange={event => setDraft({ ...draft, chatBot: { ...draft.chatBot, keywordEnabled: event.target.checked } })} />
              启用群组关键词回复
            </label>
            <dl className="cms-telegram-counts" aria-label="聊天机器人运行记录">
              <div><dt>已发送欢迎消息</dt><dd>{config.welcome.sent}</dd></div>
              <div><dt>已发送群组关键词回复</dt><dd>{config.chatBot.keywordReplies}</dd></div>
              <div><dt>最近检查（MYT）</dt><dd>{config.welcome.lastPolledAt === null ? "尚未检查" : pollTimeFormat.format(config.welcome.lastPolledAt)}</dd></div>
            </dl>
            {config.welcome.lastError && <p className="cms-telegram-last-error">最近聊天机器人异常 · {config.welcome.lastError}</p>}
          </div>
        </section>
        <section className="cms-settings-panel" aria-labelledby="telegram-private-title">
          <div>
            <h2 id="telegram-private-title">1 对 1 私聊</h2>
            <p>用户可以点击 Start 后选择关键词，或直接输入关键词。私聊沿用下方规则，可独立于群组关键词回复开启。</p>
          </div>
          <div className="cms-settings-fields">
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.chatBot.privateEnabled}
                onChange={event => setDraft({ ...draft, chatBot: {
                  ...draft.chatBot, privateEnabled: event.target.checked,
                  followup: { ...draft.chatBot.followup, enabled: event.target.checked && draft.chatBot.followup.enabled },
                } })} />
              启用 1 对 1 私聊
            </label>
            <label>私聊 Start 问候语
              <textarea rows={4} maxLength={messageLimit} value={draft.chatBot.privateStartMessage}
                placeholder="留空使用默认问候语"
                onChange={event => setDraft({ ...draft, chatBot: { ...draft.chatBot, privateStartMessage: event.target.value } })} />
              <small>用户点击 Start 或发送 /start 后收到这段问候语。留空使用默认文案。</small>
              <small>{draft.chatBot.privateStartMessage.length} / {messageLimit}</small>
            </label>
            <div className="cms-telegram-start">
              <a href={privateStartUrl} target="_blank" rel="noopener noreferrer">{privateStartUrl}</a>
              <p>可将此 Start 链接放入频道的欢迎消息，让首次接触机器人的订阅者主动开始私聊。</p>
            </div>
            <dl className="cms-telegram-counts" aria-label="私聊运行记录">
              <div><dt>已发送私聊回复</dt><dd>{config.chatBot.privateReplies}</dd></div>
            </dl>
          </div>
        </section>
        <section className="cms-settings-panel cms-telegram-followup" aria-labelledby="telegram-followup-title">
          <div>
            <h2 id="telegram-followup-title">未识别消息自动跟进</h2>
            <p>根据本系统记录的机器人私聊消息判断。顾客消息未匹配关键字时，等待 1 小时后自动发送跟进文案。</p>
            <span className={`cms-telegram-status${config.chatBot.privateEnabled && config.chatBot.followup?.enabled ? " cms-telegram-enabled" : ""}`}>
              {config.chatBot.followup?.enabled ? (config.chatBot.privateEnabled ? "已启用" : "私聊已停用") : "已停用"}
            </span>
          </div>
          <div className="cms-settings-fields">
            <label className="cms-telegram-switch">
              <input type="checkbox" role="switch" checked={draft.chatBot.followup.enabled}
                onChange={event => setDraft({ ...draft, chatBot: { ...draft.chatBot, followup: { ...draft.chatBot.followup, enabled: event.target.checked } } })} />
              启用未识别消息自动跟进
            </label>
            {!draft.chatBot.privateEnabled && <small className="cms-telegram-followup-note">需同时开启上方的“1 对 1 私聊”。</small>}
            <div className="cms-telegram-followup-delay"><strong>等待时间</strong><span>最后一条未识别消息后 1 小时</span></div>
            <label>自动跟进文案
              <textarea rows={4} maxLength={messageLimit} required={draft.chatBot.followup.enabled}
                value={draft.chatBot.followup.message} placeholder="例如：您好，还有什么可以帮您的吗？您也可以输入 /menu 查看选项。"
                onChange={event => setDraft({ ...draft, chatBot: { ...draft.chatBot, followup: { ...draft.chatBot.followup, message: event.target.value } } })} />
              <small>{draft.chatBot.followup.message.length} / {messageLimit} · 纯文字回复</small>
            </label>
            <div className="cms-telegram-followup-note">
              <p>顾客再发未识别消息会重新计算 1 小时；机器人已回复则取消待发跟进。每条最后未识别消息只跟进一次，不会每小时重复发送。</p>
              <p>启用跟进、更改跟进文案、切换私聊或更换聊天机器人后，仅处理新收到的消息，原有待发跟进会取消。</p>
              <p>顾客可发送 /stop 暂停自动跟进，发送 /start 重新开启。</p>
            </div>
            <dl className="cms-telegram-counts" aria-label="各私聊当前跟进状态">
              {Object.entries(followupLabels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{config.chatBot.followup?.counts[key as keyof FollowupStatus["counts"]] ?? 0}</dd></div>)}
            </dl>
            {config.chatBot.followup?.lastError && <p className="cms-telegram-last-error">最近跟进异常 · {config.chatBot.followup.lastError}</p>}
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
  </form><TelegramKeywordRules request={request} signInPath={signInPath} /></>;
}
