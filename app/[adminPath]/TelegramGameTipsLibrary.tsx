"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarClock, Check, Gamepad2, Image, Images, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import {
  GAME_TIPS_NAME_LIMIT, GAME_TIPS_PROVIDER_LIMIT, GAME_TIPS_UPLOAD_LIMIT, gameTipsProviderKey,
  type GameTipsAsset, type GameTipsLibrary, type GameTipsProvider,
} from "../lib/telegram-game-tips-types";
import type { ScheduledMessagePlan } from "../lib/telegram-scheduled-messages-types";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = {
  request: Request;
  signInPath: string;
  active: boolean;
  plans: ScheduledMessagePlan[];
  today: string;
  onProvidersChanged: (providers: GameTipsProvider[]) => void;
  onSchedule: (provider: string) => void;
  onEditSchedule: (plan: ScheduledMessagePlan) => void;
};
type UploadDraft = { id: string; file: File; game: string };
type LogoDraft = { id: string; provider: string; file: File | null; providerKey?: string; previousId?: string };
type Feedback = { message: string; error?: boolean; expired?: boolean };

const endpoint = "/api/admin/telegram/game-tips";
const logoEndpoint = `${endpoint}/logo`;
const imageTypes = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

function errorNotice(error: unknown, prefix = ""): Feedback {
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  const message = error instanceof Error ? error.message : "暂时无法连接，请稍后重试。";
  return { message: `${prefix}${message}`, error: true, expired: status === 401 };
}

function FilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url && <img src={url} alt={`待上传图片 ${file.name}`} loading="lazy" />;
}

function isValidImage(file: File): boolean {
  return file.size > 0 && file.size <= GAME_TIPS_UPLOAD_LIMIT
    && (/^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name));
}

async function uploadBlob(request: Request, url: string, file: File) {
  try {
    return await request<GameTipsLibrary>(url, "POST", file);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    if (typeof status === "number" && ![502, 503, 504].includes(status)) throw error;
    return request<GameTipsLibrary>(url, "POST", file);
  }
}

export default function TelegramGameTipsLibrary({
  request, signInPath, active, plans, today, onProvidersChanged, onSchedule, onEditSchedule,
}: Props) {
  const [data, setData] = useState<GameTipsLibrary | null>(null);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [logoDraft, setLogoDraft] = useState<LogoDraft | null>(null);
  const [pending, setPending] = useState<UploadDraft[]>([]);
  const [edit, setEdit] = useState<GameTipsAsset | null>(null);
  const [notice, setNotice] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [progress, setProgress] = useState({ uploaded: 0, total: 0 });
  const busyRef = useRef(false);

  useEffect(() => {
    if (!active || busyRef.current) return;
    let live = true;
    setBusy("read");
    void request<GameTipsLibrary>(endpoint).then(result => {
      if (live) setData(result);
    }).catch(error => {
      if (live) setNotice(errorNotice(error));
    }).finally(() => {
      if (live) setBusy("");
    });
    return () => { live = false; };
  }, [active, reload, request]);

  const allAssets = data?.assets || [];
  const providerMap = new Map((data?.providers || []).map(item => [gameTipsProviderKey(item.name), item]));
  for (const asset of allAssets) {
    const key = gameTipsProviderKey(asset.provider);
    if (!providerMap.has(key)) providerMap.set(key, { name: asset.provider, count: 0 });
  }
  const providers = [...providerMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const current = providerMap.get(selectedProvider)
    ?? (!selectedProvider || !pending.length && !edit && !logoDraft ? providers[0] : undefined);
  const currentKey = current ? gameTipsProviderKey(current.name) : "";
  const assets = current ? allAssets.filter(image => gameTipsProviderKey(image.provider) === currentKey) : [];
  const platformPlans = current ? plans.filter(plan => plan.gameTipsProvider
    && gameTipsProviderKey(plan.gameTipsProvider) === currentKey
    && (!plan.calendarDate || plan.calendarDate >= today)) : [];
  const editCurrent = edit && data?.assets.find(asset => asset.id === edit.id);
  const logoConflict = Boolean(logoDraft?.providerKey
    && logoDraft.previousId !== providerMap.get(logoDraft.providerKey)?.logoId);

  function switchProvider(name: string) {
    const key = gameTipsProviderKey(name);
    if (key === currentKey) return;
    if ((pending.length > 0 || edit || logoDraft) && !window.confirm("切换平台会放弃当前未保存的内容，继续？")) return;
    setSelectedProvider(key);
    setPending([]);
    setEdit(null);
    setLogoDraft(null);
    setNotice(null);
  }

  function startLogo(provider?: GameTipsProvider) {
    if (logoDraft && !window.confirm("放弃当前未保存的 Logo？")) return;
    setLogoDraft({
      id: crypto.randomUUID(), file: null, provider: provider?.name || "",
      providerKey: provider ? gameTipsProviderKey(provider.name) : undefined,
      previousId: provider?.logoId,
    });
    setNotice(null);
  }

  function chooseLogo(file?: File) {
    if (!logoDraft || !file) return;
    if (!isValidImage(file)) {
      setNotice({ message: "请为 Logo 选择不超过 4 MB 的 JPG、PNG 或 WebP。", error: true });
      return;
    }
    setLogoDraft({ ...logoDraft, id: crypto.randomUUID(), file });
    setNotice(null);
  }

  async function saveLogo(event: FormEvent) {
    event.preventDefault();
    if (!logoDraft?.file || !logoDraft.provider.trim() || busyRef.current || logoConflict) return;
    const { provider, id, file, previousId } = logoDraft;
    const name = provider.trim(), key = gameTipsProviderKey(name);
    if (!logoDraft.providerKey && providerMap.has(key)) {
      setNotice({ message: "此平台已存在。请在平台列表选中它，再上传或更换 Logo。", error: true });
      return;
    }
    if (key !== currentKey && (pending.length || edit) && !window.confirm("添加新平台会放弃当前平台未保存的游戏图片，继续？")) return;
    const params = new URLSearchParams({ id, provider: name });
    if (previousId) params.set("previousId", previousId);
    busyRef.current = true;
    setBusy("logo");
    setNotice(null);
    try {
      const result = await uploadBlob(request, `${logoEndpoint}?${params}`, file);
      setData(result);
      onProvidersChanged(result.providers);
      setSelectedProvider(key);
      setLogoDraft(null);
      if (key !== currentKey) {
        setPending([]);
        setEdit(null);
      }
      setNotice({ message: `${name} 的 Logo 已保存。` });
    } catch (error) {
      setNotice(errorNotice(error));
      if (error instanceof Error && "status" in error && error.status === 409) setReload(value => value + 1);
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  function chooseFiles(files: FileList | null) {
    if (!files?.length || !current) return;
    const chosen = Array.from(files);
    const valid = chosen.filter(isValidImage);
    setNotice(valid.length === chosen.length ? null : { message: "部分图片已略过。请选择不超过 4 MB 的 JPG、PNG 或 WebP。", error: true });
    setSelectedProvider(currentKey);
    setPending(rows => [...rows, ...valid.map(file => ({
      id: crypto.randomUUID(), file,
      game: Array.from(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).slice(0, GAME_TIPS_NAME_LIMIT).join(""),
    }))]);
  }

  async function saveUpload(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !pending.length || !current) return;
    const names = pending.map(row => gameTipsProviderKey(row.game));
    if (names.some(name => !name) || new Set(names).size !== names.length) {
      setNotice({ error: true, message: "请为每张图填写不同的游戏名称。" });
      return;
    }
    busyRef.current = true;
    setBusy("upload");
    setNotice(null);
    setProgress({ uploaded: 0, total: pending.length });
    let uploaded = 0;
    try {
      for (const row of pending) {
        try {
          const params = new URLSearchParams({ id: row.id, provider: current.name, game: row.game.trim() });
          const result = await uploadBlob(request, `${endpoint}?${params}`, row.file);
          setData(result);
          onProvidersChanged(result.providers);
          setPending(current => current.filter(item => item.id !== row.id));
          uploaded++;
          setProgress({ uploaded, total: pending.length });
        } catch (error) {
          setNotice(errorNotice(error, `${row.file.name} · `));
          return;
        }
      }
      setNotice({ message: `已上传 ${uploaded} 张 Game Tips 图片。` });
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function mutateAsset(method: "PUT" | "DELETE", asset: GameTipsAsset) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy("edit");
    setNotice(null);
    try {
      const { id, provider, game, enabled, updatedAt } = asset;
      const payload = method === "PUT"
        ? { id, provider: provider.trim(), game: game.trim(), enabled, updatedAt }
        : { id, updatedAt };
      const result = await request<GameTipsLibrary>(endpoint, method, payload);
      setData(result);
      onProvidersChanged(result.providers);
      setEdit(current => current?.id === asset.id ? null : current);
      setNotice({ message: method === "PUT" ? "游戏图片设置已保存。" : "已删除停用的游戏图片。" });
    } catch (error) {
      setNotice(errorNotice(error));
      if (error instanceof Error && "status" in error && error.status === 409) setReload(value => value + 1);
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (edit && edit.updatedAt === editCurrent?.updatedAt) void mutateAsset("PUT", edit);
  }
  function removeImage(asset: GameTipsAsset) {
    if (!asset.enabled && window.confirm(`删除已停用的游戏图片「${asset.game}」？`)) void mutateAsset("DELETE", asset);
  }

  return <div className="cms-scheduled-panel cms-game-tips-library">
    <div className="cms-scheduled-heading">
      <div><h3>Game Tips 平台图库</h3><p>按平台管理 Logo、游戏图片和独立发送排期。</p></div>
      <div className="cms-scheduled-actions">
        <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => { setNotice(null); setReload(value => value + 1); }}>
          <RefreshCw size={14} className={busy === "read" ? "cms-spin" : ""} />刷新图库
        </button>
        <button type="button" className="cms-primary" disabled={Boolean(busy)} onClick={() => startLogo()}>
          <Plus size={14} />新增平台
        </button>
      </div>
    </div>
    {notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>{notice.message}{notice.expired && <a href={signInPath} target="_top">重新登入 ↗</a>}</div>}
    {providers.length > 0 && <div className="cms-game-tips-platforms" role="group" aria-label="Game Tips 平台">
      {providers.map(item => {
        const key = gameTipsProviderKey(item.name);
        return <button className="cms-game-tips-platform-button" type="button" key={key} disabled={Boolean(busy)}
          aria-pressed={key === currentKey} onClick={() => switchProvider(item.name)}>
          <span className="cms-game-tips-platform-logo">
            {item.logoId && active ? <img src={`${logoEndpoint}?id=${item.logoId}`} alt="" loading="lazy" /> : <Gamepad2 size={21} aria-hidden="true" />}
          </span>
          <span><strong>{item.name}</strong><small>{item.count} 款游戏可用</small></span>
        </button>;
      })}
    </div>}
    {data && !providers.length && !logoDraft && <div className="cms-scheduled-empty">
      <strong>尚未添加游戏平台</strong><p>点击「新增平台」上传平台名称和 Logo，再添加该平台的游戏图片。</p>
    </div>}
    {logoDraft && <form className="cms-scheduled-card cms-scheduled-editor" onSubmit={saveLogo}>
      <fieldset disabled={Boolean(busy)}>
        <div className="cms-scheduled-heading"><h3>{logoDraft.providerKey ? "管理平台 Logo" : "新增游戏平台"}</h3>
          <button type="button" className="cms-icon-button" aria-label="关闭 Logo 编辑" onClick={() => {
            if (!logoDraft.file || window.confirm("放弃当前未保存的 Logo？")) setLogoDraft(null);
          }}><X size={15} /></button>
        </div>
        {logoConflict && <div className="cms-scheduled-conflict" role="alert">Logo 已更新。请关闭编辑后从平台重新打开以加载新版本。</div>}
        <label>平台名称<input required maxLength={GAME_TIPS_PROVIDER_LIMIT} autoComplete="off" value={logoDraft.provider}
          readOnly={Boolean(logoDraft.providerKey)} placeholder="例如 MEGA888、PUSSY88、918KISS"
          onChange={event => setLogoDraft({ ...logoDraft, provider: event.target.value })} /></label>
        <div className="cms-scheduled-heading">
          <div><h3>Logo 图片</h3><p>JPG、PNG 或 WebP，每张最多 4 MB。</p></div>
          <label className="cms-secondary cms-scheduled-file-button"><Upload size={14} />
            <span aria-hidden="true">{logoDraft.file ? "更换文件" : "选择 Logo"}</span>
            <input type="file" accept={imageTypes} aria-label="选择平台 Logo" onChange={event => {
              chooseLogo(event.target.files?.[0]); event.target.value = "";
            }} />
          </label>
        </div>
        {logoDraft.file && <div className="cms-game-tips-logo-preview"><FilePreview file={logoDraft.file} /></div>}
        <button type="submit" className="cms-primary cms-scheduled-save-channel" disabled={logoConflict || !logoDraft.file || !logoDraft.provider.trim()}>
          {busy === "logo" ? <LoaderCircle size={14} className="cms-spin" /> : <Check size={14} />}{logoDraft.providerKey ? "保存平台 Logo" : "保存新平台"}
        </button>
      </fieldset>
    </form>}
    {current && <>
    <div className="cms-scheduled-card cms-game-tips-platform-detail">
      <div className="cms-scheduled-heading">
        <div className="cms-game-tips-platform-heading">
          <span className="cms-game-tips-platform-logo">
            {current.logoId && active ? <img src={`${logoEndpoint}?id=${current.logoId}`} alt={`${current.name} Logo`} loading="lazy" /> : <Image size={22} aria-hidden="true" />}
          </span>
          <div><h3>{current.name}</h3><p>{current.logoId ? "平台 Logo 已上传" : "尚未上传平台 Logo"} · {current.count} 款可用</p></div>
        </div>
        <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => startLogo(current)}><Upload size={14} />{current.logoId ? "更换平台 Logo" : "上传平台 Logo"}</button>
      </div>
    </div>
    <div className="cms-scheduled-card cms-game-tips-platform-schedule">
      <div className="cms-scheduled-heading">
        <div><h3><CalendarClock size={15} />{current.name} 发送排期</h3><p>为此平台设置每日或指定日期的发送次数、时间和频道（MYT）。</p></div>
        <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => onSchedule(current.name)}><Plus size={14} />添加此平台排期</button>
      </div>
      {platformPlans.length ? <ul>{platformPlans.map(plan => <li key={plan.id}>
        <div><strong>{plan.name}</strong><small>{plan.calendarDate || "每天"} · {plan.times.join("、")} · {plan.enabled ? "启用中" : "已暂停"}</small></div>
        <button type="button" className="cms-icon-button" aria-label={`编辑排期 ${plan.name}`} disabled={Boolean(busy)} onClick={() => onEditSchedule(plan)}><Pencil size={14} /></button>
      </li>)}</ul> : <small className="cms-scheduled-muted">此平台还没有排期。</small>}
    </div>
    <form className="cms-scheduled-card cms-scheduled-editor" onSubmit={saveUpload}>
      <fieldset disabled={Boolean(busy)}>
        <div className="cms-scheduled-heading">
          <div><h3>上传游戏图片</h3><p>图片会加入 {current.name} 图库。可多选 JPG、PNG 或 WebP，每张最多 4 MB。</p></div>
          <label className="cms-secondary cms-scheduled-file-button">
            {busy === "upload" ? <LoaderCircle size={14} className="cms-spin" /> : <Upload size={14} />}
            <span aria-hidden="true">选择图片</span>
            <input type="file" accept={imageTypes} multiple aria-label="选择 Game Tips 图片" onChange={event => { chooseFiles(event.target.files); event.target.value = ""; }} />
          </label>
        </div>
        <datalist id="game-tips-platforms">{providers.map(item => <option key={item.name} value={item.name} />)}</datalist>
        {pending.length > 0 && <div className="cms-game-tips-upload-list">
          <small className="cms-scheduled-muted">游戏名称会出现在合成图和文案里。请把文件名建议改成图片上的实际名称。</small>
          {pending.map(row => <div className="cms-game-tips-upload-row" key={row.id}>
            <FilePreview file={row.file} />
            <label>游戏名称<input required maxLength={GAME_TIPS_NAME_LIMIT} autoComplete="off" value={row.game}
              onChange={event => setPending(rows => rows.map(item => item.id === row.id ? { ...item, game: event.target.value } : item))} />
              <small title={row.file.name}>{row.file.name}</small>
            </label>
            <button type="button" className="cms-icon-button" aria-label={`移除待上传图片 ${row.file.name}`} onClick={() => setPending(rows => rows.filter(item => item.id !== row.id))}><X size={15} /></button>
          </div>)}
          <button className="cms-primary cms-scheduled-save-channel" type="submit" disabled={pending.some(row => !row.game.trim())}>
            <Upload size={14} />上传 {pending.length} 张图片
          </button>
        </div>}
        {busy === "upload" && <div className="cms-game-tips-progress" role="status">
          <progress aria-label="Game Tips 图片上传进度" value={progress.uploaded} max={progress.total} />
          <small className="cms-scheduled-muted">已上传 {progress.uploaded} / {progress.total}</small>
        </div>}
      </fieldset>
    </form>
    <div className="cms-scheduled-heading">
      <div><h3>已上传图片</h3><p>每个平台至少需要 3 款不同游戏，才可启用对应的发送计划。</p></div>
    </div>
    {edit && <form className="cms-scheduled-card cms-scheduled-editor" onSubmit={saveEdit}>
      <fieldset disabled={Boolean(busy)}>
        <div className="cms-scheduled-heading"><h3>编辑游戏图片</h3><button className="cms-icon-button" type="button" aria-label="关闭图片编辑" onClick={() => setEdit(null)}><X size={15} /></button></div>
        {editCurrent?.updatedAt !== edit.updatedAt && <div className="cms-scheduled-conflict" role="alert">
          图片资料已更新，请加载最新版本后编辑。
          {editCurrent && <button className="cms-secondary" type="button" onClick={() => setEdit(editCurrent)}>加载最新资料</button>}
        </div>}
        <div className="cms-scheduled-form-grid">
          <label>游戏平台<input list="game-tips-platforms" required maxLength={GAME_TIPS_PROVIDER_LIMIT} value={edit.provider} onChange={event => setEdit({ ...edit, provider: event.target.value })} /></label>
          <label>游戏名称<input required maxLength={GAME_TIPS_NAME_LIMIT} value={edit.game} onChange={event => setEdit({ ...edit, game: event.target.value })} /></label>
        </div>
        <label className="cms-telegram-switch"><input type="checkbox" role="switch" checked={edit.enabled} onChange={event => setEdit({ ...edit, enabled: event.target.checked })} />加入随机图库</label>
        <button type="submit" className="cms-primary cms-scheduled-save-channel" disabled={editCurrent?.updatedAt !== edit.updatedAt || !edit.provider.trim() || !edit.game.trim()}><Check size={14} />保存图片资料</button>
      </fieldset>
    </form>}
    {!assets.length && <div className="cms-scheduled-empty"><Images size={15} /><strong>{current.name} 还没有游戏图片</strong><p>上传至少 3 款不同游戏后即可启用 Game Tips 排期。</p></div>}
    {active && assets.length > 0 && <div className="cms-game-tips-image-grid">{assets.map(asset => <article className="cms-scheduled-card cms-game-tips-image" key={asset.id}>
      <img src={`${endpoint}?id=${asset.id}`} alt={`${asset.provider} · ${asset.game}`} loading="lazy" />
      <div><strong>{asset.game}</strong><small>{asset.provider}</small></div>
      <div className="cms-scheduled-heading">
        <span className={`cms-scheduled-pill ${asset.enabled ? "cms-scheduled-good" : ""}`}>{asset.enabled ? "可用于抽图" : "已停用"}</span>
        <div className="cms-scheduled-actions">
          <button type="button" className="cms-secondary" aria-label={`编辑图片 ${asset.game}`} disabled={Boolean(busy)} onClick={() => { setNotice(null); setEdit(asset); }}><Pencil size={13} />编辑</button>
          {!asset.enabled && <button type="button" className="cms-icon-button" aria-label={`删除停用图片 ${asset.game}`} disabled={Boolean(busy)} onClick={() => removeImage(asset)}><Trash2 size={13} /></button>}
        </div>
      </div>
    </article>)}</div>}
    </>}
    {!data && busy === "read" && <p className="cms-scheduled-loading" role="status"><LoaderCircle size={15} className="cms-spin" />正在读取图库…</p>}
  </div>;
}
