"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Gamepad2, Images, LoaderCircle, Pencil, RefreshCw, Trash2, Upload, X } from "lucide-react";
import {
  GAME_TIPS_NAME_LIMIT, GAME_TIPS_PROVIDER_LIMIT, GAME_TIPS_UPLOAD_LIMIT, gameTipsProviderKey,
  type GameTipsAsset, type GameTipsLibrary, type GameTipsProvider,
} from "../lib/telegram-game-tips-types";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = {
  request: Request;
  signInPath: string;
  active: boolean;
  onProvidersChanged: (providers: GameTipsProvider[]) => void;
  onSchedule: () => void;
};
type UploadDraft = { id: string; file: File; game: string };
type Feedback = { message: string; error?: boolean; expired?: boolean };

const endpoint = "/api/admin/telegram/game-tips";
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

async function uploadImage(request: Request, provider: string, row: UploadDraft) {
  const params = new URLSearchParams({ id: row.id, provider, game: row.game.trim() });
  const url = `${endpoint}?${params}`;
  try {
    return await request<GameTipsLibrary>(url, "POST", row.file);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    if (typeof status === "number" && ![502, 503, 504].includes(status)) throw error;
    return request<GameTipsLibrary>(url, "POST", row.file);
  }
}

export default function TelegramGameTipsLibrary({ request, signInPath, active, onProvidersChanged, onSchedule }: Props) {
  const [data, setData] = useState<GameTipsLibrary | null>(null);
  const [provider, setProvider] = useState("");
  const [pending, setPending] = useState<UploadDraft[]>([]);
  const [edit, setEdit] = useState<GameTipsAsset | null>(null);
  const [filter, setFilter] = useState("");
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

  const providers = data?.providers || [];
  const providerNames = [...new Set((data?.assets || []).map(image => image.provider))].sort();
  const selectedFilter = providerNames.includes(filter) ? filter : "";
  const assets = (data?.assets || []).filter(image => !selectedFilter || image.provider === selectedFilter);
  const editCurrent = edit && data?.assets.find(asset => asset.id === edit.id);

  function chooseFiles(files: FileList | null) {
    if (!files?.length) return;
    const chosen = Array.from(files);
    const valid = chosen.filter(file => file.size > 0 && file.size <= GAME_TIPS_UPLOAD_LIMIT
      && (/^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)));
    setNotice(valid.length === chosen.length ? null : { message: "部分图片已略过。请选择不超过 4 MB 的 JPG、PNG 或 WebP。", error: true });
    setPending(rows => [...rows, ...valid.map(file => ({
      id: crypto.randomUUID(), file,
      game: Array.from(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).slice(0, GAME_TIPS_NAME_LIMIT).join(""),
    }))]);
  }

  async function saveUpload(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !pending.length) return;
    const names = pending.map(row => gameTipsProviderKey(row.game));
    if (!provider.trim() || names.some(name => !name) || new Set(names).size !== names.length) {
      setNotice({ error: true, message: "请选择平台并为每张图填写不同的游戏名称。" });
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
          const result = await uploadImage(request, provider.trim(), row);
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
      <div><h3>Game Tips 图库</h3><p>上传单款游戏的图片，核对图上的平台和游戏名称，再用图库创建定时计划。</p></div>
      <div className="cms-scheduled-actions">
        <button type="button" className="cms-secondary" disabled={Boolean(busy)} onClick={() => { setNotice(null); setReload(value => value + 1); }}>
          <RefreshCw size={14} className={busy === "read" ? "cms-spin" : ""} />刷新图库
        </button>
        <button type="button" className="cms-primary" disabled={Boolean(busy) || !providers.some(item => item.count >= 3)} onClick={onSchedule}>
          <Gamepad2 size={14} />设置 Game Tips 排期
        </button>
      </div>
    </div>
    {notice && <div className={`cms-alert ${notice.error ? "cms-error" : "cms-success"}`} role={notice.error ? "alert" : "status"}>{notice.message}{notice.expired && <a href={signInPath} target="_top">重新登入 ↗</a>}</div>}
    {providers.length > 0 && <div className="cms-game-tips-pills">{providers.map(item => <span key={item.name} className={`cms-scheduled-pill ${item.count >= 3 ? "cms-scheduled-good" : ""}`}>{item.name} · {item.count} 款可用</span>)}</div>}
    <form className="cms-scheduled-card cms-scheduled-editor" onSubmit={saveUpload}>
      <fieldset disabled={Boolean(busy)}>
        <div className="cms-scheduled-heading">
          <div><h3>上传游戏图片</h3><p>同一批图片共用一个平台名称。可多选 JPG、PNG 或 WebP，每张最多 4 MB。</p></div>
          <label className="cms-secondary cms-scheduled-file-button">
            {busy === "upload" ? <LoaderCircle size={14} className="cms-spin" /> : <Upload size={14} />}
            <span aria-hidden="true">选择图片</span>
            <input type="file" accept={imageTypes} multiple aria-label="选择 Game Tips 图片" onChange={event => { chooseFiles(event.target.files); event.target.value = ""; }} />
          </label>
        </div>
        <label>游戏平台<input list="game-tips-platforms" required maxLength={GAME_TIPS_PROVIDER_LIMIT} autoComplete="off" value={provider}
          placeholder="例如 MEGA888" onChange={event => setProvider(event.target.value)} /></label>
        <datalist id="game-tips-platforms">{providerNames.map(name => <option key={name} value={name} />)}</datalist>
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
          <button className="cms-primary cms-scheduled-save-channel" type="submit" disabled={!provider.trim() || pending.some(row => !row.game.trim())}>
            <Upload size={14} />上传 {pending.length} 张图片
          </button>
        </div>}
        {busy === "upload" && <div className="cms-game-tips-progress" role="status">
          <progress aria-label="Game Tips 图片上传进度" value={progress.uploaded} max={progress.total} />
          <small className="cms-scheduled-muted">已上传 {progress.uploaded} / {progress.total}</small>
        </div>}
      </fieldset>
    </form>
    {data && <div className="cms-scheduled-heading">
      <div><h3>已上传图片</h3><p>每个平台至少需要 3 款不同游戏，才可启用对应的发送计划。</p></div>
      {providerNames.length > 1 && <label className="cms-scheduled-filter">按平台筛选<select value={selectedFilter} onChange={event => setFilter(event.target.value)}>
        <option value="">全部平台</option>
        {providerNames.map(name => <option key={name} value={name}>{name}</option>)}
      </select></label>}
    </div>}
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
    {!data && busy === "read" && <p className="cms-scheduled-loading" role="status"><LoaderCircle size={15} className="cms-spin" />正在读取图库…</p>}
    {data && !assets.length && <div className="cms-scheduled-empty"><Images size={15} /><strong>这里还没有游戏图片</strong><p>先为同一平台上传至少 3 款游戏，再创建 Game Tips 排期。</p></div>}
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
  </div>;
}
