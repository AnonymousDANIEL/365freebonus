"use client";

import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import { Check, ImageIcon, LoaderCircle, Megaphone, Pencil, Plus, Trash2, X } from "lucide-react";
import { isSafeSocialUrl } from "../lib/directory";
import { isSafeImageUrl } from "../lib/image-url";
import type { PopupNotice } from "../lib/popup-notices";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type NoticeDraft = Omit<PopupNotice, "id" | "sortOrder"> & { id?: number; sortOrder: number | "" };
type Feedback = { message: string; error?: boolean; sessionExpired?: boolean };
type Props = {
  request: AdminRequest;
  signInPath: string;
  uploadImage: (file: File) => Promise<string>;
  UploadButton: ComponentType<{ label: string; uploading: boolean; onUpload: (file: File) => void }>;
};

const endpoint = "/api/admin/notices";
const emptyNotice: NoticeDraft = { title: "", imageUrl: "", link: "", enabled: true, sortOrder: 10 };

function requestFailure(error: unknown): Feedback {
  return {
    message: error instanceof Error ? error.message : "操作失败，请重试。",
    error: true,
    sessionExpired: error instanceof Error && "status" in error && error.status === 401,
  };
}

export default function PopupNoticeSettings({ request, signInPath, uploadImage, UploadButton }: Props) {
  const [notices, setNotices] = useState<PopupNotice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<NoticeDraft | null>(null);
  const [deleting, setDeleting] = useState<PopupNotice | null>(null);
  const [action, setAction] = useState<"upload" | "save" | "toggle" | "delete" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [imageName, setImageName] = useState("");
  const [failedImage, setFailedImage] = useState("");
  const editor = useRef<HTMLDialogElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const busy = action !== null;
  const editorOpen = editing !== null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFeedback(null);
    request<{ notices: PopupNotice[] }>(endpoint).then(result => {
      if (active) setNotices(result.notices);
    }).catch(error => {
      if (active) setFeedback(requestFailure(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, reload]);

  useEffect(() => {
    if (editorOpen) editor.current?.showModal();
    else editor.current?.close();
  }, [editorOpen]);

  useEffect(() => {
    if (deleting) confirmation.current?.showModal();
    else confirmation.current?.close();
  }, [deleting]);

  function openEditor(notice?: PopupNotice) {
    setFeedback(null);
    setImageName("");
    setFailedImage("");
    setEditing({ ...(notice ?? emptyNotice) });
  }

  function closeEditor() {
    setFeedback(null);
    setEditing(null);
  }

  async function upload(file: File) {
    if (!editing || busy) return;
    setAction("upload");
    setFeedback(null);
    try {
      const imageUrl = await uploadImage(file);
      setEditing(current => current === editing ? { ...current, imageUrl } : current);
      setImageName(file.name);
      setFailedImage("");
    } catch (error) {
      setFeedback(requestFailure(error));
    } finally {
      setAction(null);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || busy) return;
    const { id, enabled, sortOrder } = editing;
    const title = editing.title.trim();
    const imageUrl = editing.imageUrl.trim();
    const link = editing.link.trim();
    if (!title || !imageUrl || !isSafeImageUrl(imageUrl)) {
      setFeedback({ message: "请填写公告标题并上传图片，或填写有效的图片地址。", error: true });
      return;
    }
    if (link && !isSafeSocialUrl(link)) {
      setFeedback({ message: "网站链接须使用完整的 HTTP 或 HTTPS 地址。", error: true });
      return;
    }
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 99999) {
      setFeedback({ message: "展示顺序请输入 0 至 99999 的整数。", error: true });
      return;
    }
    setAction("save");
    setFeedback(null);
    try {
      const body = { title, imageUrl, link, enabled, sortOrder };
      const { notice } = await request<{ notice: PopupNotice }>(endpoint, id === undefined ? "POST" : "PUT",
        id === undefined ? body : { id, ...body });
      setNotices(current => id === undefined ? [...(current ?? []), notice] : current?.map(item => item.id === id ? notice : item) ?? []);
      setEditing(null);
      setFeedback({ message: "公告已保存。" });
    } catch (error) {
      setFeedback(requestFailure(error));
    } finally {
      setAction(null);
    }
  }

  async function toggle(item: PopupNotice) {
    if (busy) return;
    setAction("toggle");
    setFeedback(null);
    try {
      const { notice } = await request<{ notice: PopupNotice }>(endpoint, "PUT", { ...item, enabled: !item.enabled });
      setNotices(current => current?.map(entry => entry.id === notice.id ? notice : entry) ?? []);
      setFeedback({ message: notice.enabled ? "公告已启用。" : "公告已停用。" });
    } catch (error) {
      setFeedback(requestFailure(error));
    } finally {
      setAction(null);
    }
  }

  async function remove() {
    if (!deleting || busy) return;
    setAction("delete");
    setFeedback(null);
    try {
      const { id } = await request<{ id: number }>(endpoint, "DELETE", { id: deleting.id });
      setNotices(current => current?.filter(item => item.id !== id) ?? []);
      setDeleting(null);
      setFeedback({ message: "公告已删除。" });
    } catch (error) {
      setFeedback(requestFailure(error));
    } finally {
      setAction(null);
    }
  }

  const sorted = [...(notices ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const imageUrl = editing?.imageUrl.trim() ?? "";
  const previewSrc = isSafeImageUrl(imageUrl) && imageUrl !== failedImage ? imageUrl : "";
  const message = feedback && <div className={`cms-alert ${feedback.error ? "cms-error" : "cms-success"}`} role={feedback.error ? "alert" : "status"}>
    <span>{feedback.message}</span>
    {feedback.sessionExpired && <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>}
  </div>;

  return <>
    {!editing && !deleting && message}
    {loading ? <div className="cms-loading" role="status"><LoaderCircle size={24} className="cms-spin" /><p>正在加载公告…</p></div> : notices === null ?
      <div className="cms-empty"><Megaphone size={27} /><h3>暂时无法加载公告</h3><button type="button" className="cms-secondary" onClick={() => setReload(previous => previous + 1)}>重新加载</button></div> :
      <section className="cms-brand-panel cms-popup-notices" aria-label="弹窗公告列表">
        <div className="cms-panel-tools">
          <strong>{sorted.length} 则公告</strong>
          <button type="button" className="cms-primary" disabled={busy} onClick={() => openEditor()}><Plus size={16} />添加公告</button>
        </div>
        {sorted.length ? <div className="cms-table-scroll"><table className="cms-table">
          <thead><tr><th>公告</th><th>网站链接</th><th>状态</th><th>顺序</th><th className="cms-actions-heading">操作</th></tr></thead>
          <tbody>{sorted.map(item => <tr key={item.id}>
            <td><div className="cms-brand-cell"><span className="cms-popup-notice-thumb"><img src={item.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /></span><strong title={item.title}>{item.title}</strong></div></td>
            <td>{item.link ? "已设置" : "未设置"}</td>
            <td><button type="button" disabled={busy} className={`cms-status ${item.enabled ? "published" : "draft"}`}
              aria-label={`${item.enabled ? "停用" : "启用"} ${item.title}`} onClick={() => void toggle(item)}><i />{item.enabled ? "已启用" : "已停用"}</button></td>
            <td><span className="cms-order">{item.sortOrder}</span></td>
            <td><div className="cms-row-actions">
              <button type="button" disabled={busy} aria-label={`编辑 ${item.title}`} onClick={() => openEditor(item)}><Pencil size={16} /></button>
              <button type="button" className="cms-delete" disabled={busy} aria-label={`删除 ${item.title}`} onClick={() => { setFeedback(null); setDeleting(item); }}><Trash2 size={16} /></button>
            </div></td>
          </tr>)}</tbody>
        </table></div> : <div className="cms-empty"><Megaphone size={29} /><h3>尚未添加弹窗公告</h3><p>添加图片后，可设置网站链接和展示顺序。</p></div>}
        <div className="cms-panel-footer"><small>数字越小越先显示。</small></div>
      </section>}

    <dialog ref={editor} className="cms-dialog" aria-labelledby="popup-notice-editor-title"
      onCancel={event => { if (busy) event.preventDefault(); else closeEditor(); }}
      onClick={event => { if (event.target === editor.current && !busy) closeEditor(); }}>
      {editing && <form onSubmit={save}>
        <div className="cms-dialog-heading">
          <h2 id="popup-notice-editor-title">{editing.id === undefined ? "添加弹窗公告" : "编辑弹窗公告"}</h2>
          <button type="button" disabled={busy} onClick={closeEditor} aria-label="关闭编辑"><X size={21} /></button>
        </div>
        <fieldset className="cms-dialog-body" disabled={busy}>
          {message}
          <div className="cms-form-grid">
            <label>公告标题<input autoFocus required maxLength={100} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
            <label>展示顺序<input type="number" required min={0} max={99999} step={1} value={editing.sortOrder}
              onChange={event => setEditing({ ...editing, sortOrder: event.target.value === "" ? "" : Number(event.target.value) })} /></label>
            <div className="cms-wide cms-popup-notice-image">
              <div className="cms-image-preview cms-popup-notice-preview">
                {previewSrc ? <img src={previewSrc} alt="公告图片预览" referrerPolicy="no-referrer" onError={() => setFailedImage(previewSrc)} /> :
                  <div><ImageIcon size={24} /><span>{imageUrl ? "图片无法预览" : "上传公告图片"}</span></div>}
              </div>
              <div className="cms-image-actions"><UploadButton label="上传公告图片" uploading={action === "upload"} onUpload={file => void upload(file)} /></div>
              <small className="cms-photo-hint">图片在 2:1 画框中居中裁切。支持 JPG、PNG、GIF、WebP，每张最多 5 MB。</small>
              {imageName && <div className="cms-image-filename" role="status"><Check size={14} />已上传 {imageName}</div>}
              <label>图片地址<input required type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} value={editing.imageUrl}
                placeholder="上传图片后自动填写，也可粘贴地址" onChange={event => {
                  setEditing({ ...editing, imageUrl: event.target.value });
                  setImageName("");
                  setFailedImage("");
                }} /></label>
            </div>
            <label className="cms-wide">网站链接<input type="url" maxLength={2048} placeholder="https://…" value={editing.link}
              onChange={event => setEditing({ ...editing, link: event.target.value })} /><small>可选。填写后点击前台公告图片会打开此网站。</small></label>
          </div>
          <div className="cms-switches"><label><span><strong>启用公告</strong><small>保存后在首页展示。</small></span><input type="checkbox" checked={editing.enabled}
            onChange={event => setEditing({ ...editing, enabled: event.target.checked })} /></label></div>
        </fieldset>
        <div className="cms-dialog-footer">
          <button type="button" className="cms-secondary" disabled={busy} onClick={closeEditor}>取消</button>
          <button type="submit" className="cms-primary" disabled={busy}>{busy ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}{action === "upload" ? "正在上传…" : action === "save" ? "正在保存…" : "保存公告"}</button>
        </div>
      </form>}
    </dialog>

    <dialog ref={confirmation} className="cms-confirm cms-delete-dialog" aria-labelledby="popup-notice-delete-title"
      onCancel={event => { if (busy) event.preventDefault(); else { setFeedback(null); setDeleting(null); } }}>
      {deleting && <>
        <span className="cms-confirm-icon"><Trash2 size={23} /></span>
        <h2 id="popup-notice-delete-title">删除 {deleting.title}？</h2>
        <p>确认后，前台会移除这则公告。</p>
        {message}
        <div className="cms-confirm-actions">
          <button type="button" autoFocus className="cms-secondary" disabled={busy} onClick={() => { setFeedback(null); setDeleting(null); }}>取消</button>
          <button type="button" className="cms-danger" disabled={busy} onClick={() => void remove()}>{busy ? "正在删除…" : "确认删除"}</button>
        </div>
      </>}
    </dialog>
  </>;
}
