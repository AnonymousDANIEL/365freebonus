"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import "./telegram-account-admin.css";

type Channel = { id: string; title: string; username: string; selected: boolean; joined: boolean };
type AccountStatus = {
  connected: boolean;
  stage: "disconnected" | "code" | "password" | "connected";
  hasApiCredentials: boolean;
  lastError: string;
  lastPolledAt: number | null;
  syncedAt: number | null;
  retryAt?: number | null;
  retrySource?: "telegram" | "connection" | null;
  channels: Channel[];
};
type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = { request: AdminRequest; signInPath: string };
type Notice = { message: string; error?: boolean; sessionExpired?: boolean };
const endpoint = "/api/admin/telegram/account";
const myt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export default function TelegramPersonalAccount({ request, signInPath }: Props) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const requestVersion = useRef(0);
  const alive = useRef(false);
  const focusChannel = useRef<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;

  function accept(value: AccountStatus, force = false) {
    setStatus(value);
    setClock(Date.now());
    if (value.connected || value.stage !== "disconnected") setApiHash("");
    if (force || !dirtyRef.current) {
      setSelected(value.channels.filter(channel => channel.selected && channel.joined).map(channel => channel.id));
      dirtyRef.current = false;
      setDirty(false);
    }
  }

  function showError(error: unknown) {
    setNotice({ message: error instanceof Error ? error.message : "暂时无法连接 Telegram，请稍后再试。", error: true,
      sessionExpired: error instanceof Error && "status" in error && error.status === 401 });
  }

  useEffect(() => {
    alive.current = true;
    const load = async (first = false) => {
      if (busyRef.current) return;
      const version = requestVersion.current;
      try {
        const value = await requestRef.current<AccountStatus>(endpoint);
        if (alive.current && version === requestVersion.current && !busyRef.current) accept(value);
      } catch (error) { if (alive.current && first) showError(error); }
      finally { if (alive.current && first) setLoading(false); }
    };
    void load(true);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { alive.current = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!focusChannel.current) return;
    const input = document.getElementById(`telegram-source-${focusChannel.current}`)
      ?? document.getElementById("telegram-source-search");
    input?.focus({ preventScroll: true });
    focusChannel.current = null;
  }, [selected]);

  async function act(body: Record<string, unknown>, message: string, forceSelection = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    setNotice(null);
    try {
      const value = await requestRef.current<AccountStatus>(endpoint, "POST", body);
      if (!alive.current) return;
      accept(value, forceSelection);
      if (body.action === "sendCode" || body.action === "disconnect") { setApiId(""); setApiHash(""); setPhone(""); }
      setNotice({ message });
    } catch (error) {
      if (alive.current) showError(error);
      // This reads local saved state only; it never requests another login code.
      // Refresh immediately so a failed connection shows its actual retry timer.
      try {
        const value = await requestRef.current<AccountStatus>(endpoint);
        if (alive.current && version === requestVersion.current) accept(value);
      } catch { /* Keep the original action failure visible. */ }
    }
    finally {
      // Retain a failed login's masked API Hash in React memory for retry only.
      // It is cleared after successful authorization and never stored in the browser.
      setCode(""); setPassword("");
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function reload() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice(null);
    requestVersion.current++;
    try {
      const value = await requestRef.current<AccountStatus>(endpoint);
      if (alive.current) { accept(value); setLoading(false); }
    } catch (error) { if (alive.current) showError(error); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  function toggle(id: string, checked: boolean) {
    focusChannel.current = id;
    dirtyRef.current = true; setDirty(true);
    setSelected(previous => checked ? [...new Set([...previous, id])] : previous.filter(value => value !== id));
  }

  const search = query.trim().toLocaleLowerCase();
  const selectedIds = new Set(selected);
  const joinedChannels = (status?.channels ?? []).filter(channel => channel.joined);
  const selectedChannels = joinedChannels.filter(channel => selectedIds.has(channel.id));
  const availableChannels = joinedChannels.filter(channel => !selectedIds.has(channel.id));
  const matchingChannels = availableChannels.filter(channel => !search || `${channel.title} ${channel.username}`.toLocaleLowerCase().includes(search));
  const leftChannels = (status?.channels ?? []).filter(channel => !channel.joined);
  const selectedCount = selectedChannels.length;
  const savedCount = joinedChannels.filter(channel => channel.selected).length;
  const stage = status?.stage ?? "disconnected";
  const retrySeconds = Math.max(0, Math.ceil(((status?.retryAt ?? 0) - clock) / 1_000));
  const waiting = retrySeconds > 0;

  return <section className="cms-settings-panel cms-telegram-account" aria-labelledby="telegram-personal-account-title"
    onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <div>
      <h2 id="telegram-personal-account-title">个人账号来源频道</h2>
      <p>连接你的 Telegram 个人账号，勾选已加入的频道。系统读取勾选频道的新图片、视频或 GIF 及其文案，再由 @FreeBonus365Bot 发送。</p>
      <span className={`cms-telegram-status${status?.connected ? " cms-telegram-enabled" : ""}`}>
        {status?.connected ? "个人账号已连接" : stage === "code" ? "等待验证码" : stage === "password" ? "等待两步验证" : "尚未连接"}
      </span>
    </div>
    <div className="cms-settings-fields">
      {loading ? <p className="cms-telegram-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在加载个人账号…</p> : !status ?
        <div><button className="cms-secondary" type="button" disabled={busy} onClick={() => void reload()}>重新加载</button></div> :
        <fieldset className="cms-settings-fields cms-telegram-account-fields" disabled={busy}>
          {!status.connected && stage === "disconnected" && <>
            <p className="cms-telegram-account-help">在 <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">Telegram API development tools ↗</a> 获取你自己的 API ID 和 API Hash，然后在这里连接。请只在此后台填写，不要在聊天中发送验证码或密码。</p>
            <div className="cms-telegram-account-grid">
              <label>API ID
                <input type="text" inputMode="numeric" autoComplete="off" maxLength={10} value={apiId}
                  onChange={event => setApiId(event.target.value.replace(/\D/g, ""))} placeholder="数字 API ID" />
              </label>
              <label>API Hash
                <input type="password" autoComplete="new-password" spellCheck={false} maxLength={32} value={apiHash}
                  onChange={event => setApiHash(event.target.value)} placeholder="32 位 API Hash" />
              </label>
            </div>
            <label>Telegram 手机号码（含国家码）
              <input type="tel" autoComplete="off" maxLength={20} value={phone} onChange={event => setPhone(event.target.value)} placeholder="+60123456789" />
            </label>
            <div><button type="button" className="cms-primary" disabled={waiting || !/^\d{1,10}$/.test(apiId) || !/^[a-fA-F0-9]{32}$/.test(apiHash.trim()) || !/^\+[1-9]\d{6,14}$/.test(phone.replace(/\s/g, ""))}
              onClick={() => void act({ action: "sendCode", apiId: Number(apiId), apiHash: apiHash.trim(), phone: phone.replace(/\s/g, "") }, "验证码已请求，请在 Telegram 中查看。")}>{waiting ? `${retrySeconds} 秒后可重试` : "获取登入验证码"}</button></div>
          </>}
          {!status.connected && stage === "code" && <>
            <label>Telegram 登入验证码
              <input type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={code}
                onChange={event => setCode(event.target.value.replace(/\D/g, ""))} placeholder="填写 Telegram 发送的验证码" />
              <small>验证码仅用于这次登入，过期后请取消连接并重新获取。</small>
            </label>
            <div className="cms-telegram-account-actions">
              <button type="button" className="cms-primary" disabled={waiting || !/^\d{3,12}$/.test(code)} onClick={() => void act({ action: "code", code }, "验证码已提交，请查看连接状态。", true)}>确认验证码</button>
              <button type="button" className="cms-secondary" onClick={() => void act({ action: "disconnect" }, "已取消个人账号连接。", true)}>取消连接</button>
            </div>
          </>}
          {!status.connected && stage === "password" && <>
            <label>Telegram 两步验证密码
              <input type="password" autoComplete="new-password" maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
              <small>这是你在 Telegram 设置的两步验证密码，只用于这次登入。</small>
            </label>
            <div className="cms-telegram-account-actions">
              <button type="button" className="cms-primary" disabled={waiting || !password} onClick={() => void act({ action: "password", password }, "个人账号连接已更新。", true)}>确认两步验证</button>
              <button type="button" className="cms-secondary" onClick={() => void act({ action: "disconnect" }, "已取消个人账号连接。", true)}>取消连接</button>
            </div>
          </>}
          {status.connected && <>
            <div className="cms-telegram-account-actions">
              <button type="button" className="cms-secondary" disabled={waiting} onClick={() => void act({ action: "refresh" }, "频道列表已更新。") }><RefreshCw size={15} />刷新频道列表</button>
              <button type="button" className="cms-secondary" onClick={() => void act({ action: "disconnect" }, "个人账号已断开，已停止读取来源频道。", true)}>断开个人账号</button>
            </div>
            <small>你的账号加入新频道后会自动更新列表；只有勾选并保存的频道才会转发。首次勾选从保存后的新消息开始，不补发历史内容。</small>
            <section className="cms-telegram-source-section cms-telegram-source-selected" aria-labelledby="telegram-selected-sources-title">
              <div className="cms-telegram-source-heading">
                <h3 id="telegram-selected-sources-title"><Check size={16} />已勾选频道 <span className="cms-telegram-source-count">{selectedCount}</span></h3>
                <small role="status">已保存 {savedCount} 个{dirty ? " · 有未保存的更改" : " · 选择已保存"}</small>
              </div>
              <p className="cms-telegram-source-help">这里单独列出当前勾选的频道；取消勾选后会移到下方。更改后请保存。</p>
              <div className="cms-telegram-channel-list cms-telegram-channel-cards" aria-label="已勾选的来源频道">
                {selectedCount === 0 ? <p className="cms-telegram-account-empty">还没有勾选频道，请从下方选择来源。</p> :
                  selectedChannels.map(channel => <label className="cms-telegram-channel cms-telegram-channel-selected" key={channel.id}>
                    <input id={`telegram-source-${channel.id}`} type="checkbox" checked
                      onChange={event => toggle(channel.id, event.target.checked)} />
                    <span><strong>{channel.title || "未命名频道"}</strong><small>{channel.username ? `@${channel.username.replace(/^@/, "")}` : "私密频道"}</small>
                      <small className="cms-telegram-source-state">{channel.selected ? "已保存" : "待保存后生效"}</small></span>
                  </label>)}
              </div>
            </section>
            <div className="cms-telegram-account-actions cms-telegram-source-save">
              <button type="button" className="cms-primary" disabled={waiting || !dirty} onClick={() => void act({ action: "select", channelIds: selected.filter(id => status.channels.some(channel => channel.id === id && channel.joined)) }, "来源频道选择已保存。", true)}><Check size={15} />保存来源频道</button>
              <small role="status">当前勾选 {selectedCount} 个频道{dirty ? " · 尚未保存" : " · 已保存"}</small>
            </div>
            <section className="cms-telegram-source-section" aria-labelledby="telegram-available-sources-title">
              <div className="cms-telegram-source-heading">
                <h3 id="telegram-available-sources-title">未勾选频道 <span className="cms-telegram-source-count">{availableChannels.length}</span></h3>
                <small>勾选后会显示在上方</small>
              </div>
              <label>搜索未勾选的频道
                <input id="telegram-source-search" type="search" autoComplete="off" maxLength={100} value={query} onChange={event => setQuery(event.target.value)} placeholder="频道名称或用户名" />
              </label>
              {search && <small role="status">找到 {matchingChannels.length} 个 · 未勾选共 {availableChannels.length} 个</small>}
              <div className="cms-telegram-channel-list cms-telegram-channel-cards" aria-label="未勾选的来源频道">
                {matchingChannels.length === 0 ? <p className="cms-telegram-account-empty">{search ? "没有找到匹配的频道。" : joinedChannels.length === 0 ? "尚未识别到你已加入的频道。加入后点击刷新频道列表。" : "已加入的频道都已勾选。"}</p> :
                  matchingChannels.map(channel => <label className="cms-telegram-channel" key={channel.id}>
                    <input id={`telegram-source-${channel.id}`} type="checkbox" checked={false}
                      onChange={event => toggle(channel.id, event.target.checked)} />
                    <span><strong>{channel.title || "未命名频道"}</strong><small>{channel.username ? `@${channel.username.replace(/^@/, "")}` : "私密频道"}</small>
                      {channel.selected && <small className="cms-telegram-source-state">待取消 · 保存后停止读取</small>}</span>
                  </label>)}
              </div>
            </section>
            {leftChannels.length > 0 && <details className="cms-telegram-source-left">
              <summary>已离开的频道 · {leftChannels.length} 个（停止读取）</summary>
              <ul>{leftChannels.map(channel => <li key={channel.id}><strong>{channel.title || "未命名频道"}</strong><small>{channel.username ? `@${channel.username.replace(/^@/, "")}` : "私密频道"} · 已离开，停止读取</small></li>)}</ul>
            </details>}
            <small>发送目标使用「图片自动转发」中的群组或频道；请启用转发并保存目标设置。发到频道时，@FreeBonus365Bot 需要目标频道的管理员发布权限。</small>
          </>}
          {waiting && <small className="cms-telegram-account-retry">
            {status.retrySource === "telegram" ? "Telegram 要求暂缓请求" : "上次连接失败，系统正在等待重试"}，{retrySeconds} 秒后可以再次操作。等待期间可以修改资料。
          </small>}
          <small>最近读取（马来西亚时间）：{status.lastPolledAt ? myt.format(status.lastPolledAt) : "尚未读取"}；列表同步：{status.syncedAt ? myt.format(status.syncedAt) : "尚未同步"}</small>
          {status.lastError && <p className="cms-telegram-last-error" role="alert">个人账号异常 · {status.lastError}</p>}
        </fieldset>}
      {busy && <p className="cms-telegram-loading" role="status"><LoaderCircle size={16} className="cms-spin" />正在处理个人账号设置…</p>}
      {notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>
        <span>{notice.message}</span>{notice.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
      </div>}
    </div>
  </section>;
}
