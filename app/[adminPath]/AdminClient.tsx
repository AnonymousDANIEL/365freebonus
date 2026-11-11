"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, CircleHelp, ExternalLink, Eye, FileText, ImageIcon, KeyRound, LayoutGrid, LoaderCircle, Megaphone, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, Trash2, Upload, UserRound, X, Pencil, Globe, LockKeyhole, LogOut, Orbit, Sun, Gamepad2, Moon, Triangle } from "lucide-react";
import { DEFAULT_PROMOTION_DAYS, effectiveBrandCategory, isBrandPublished, isSafeSocialUrl, isValidPromotionStart, type Brand, type SiteSettings } from "../lib/directory";
import { isSafeImageUrl, isUploadedImageUrl } from "../lib/image-url";
import { AdminThemeToggle, useAdminTheme } from "../components/AdminTheme";
import TelegramGroupSettings from "./TelegramGroupSettings";
import PopupNoticeSettings from "./PopupNoticeSettings";
import PasswordSettings from "./PasswordSettings";
import SecureNotes from "./SecureNotes";
import NotesActivity from "./NotesActivity";
import "./social-contacts-admin.css";
import "./password-settings-admin.css";

const sections = {
  brands: { title: "品牌管理", description: "在一个地方，管理每个值得被发现的品牌。" },
  settings: { title: "网站设置", description: "让首页文字、站名和公告，都保持你的风格。" },
  notices: { title: "弹窗公告", description: "上传公告图片，设置点击链接和展示顺序。" },
  telegram: { title: "Telegram 通知", description: "管理品牌更新的自动通知，查看发送状态。" },
  notes: { title: "安全笔记", description: "管理私人记录，使用独立 PIN 保护。" },
  password: { title: "更改密码", description: "在后台直接更换管理员密码。" },
};
type Section = keyof typeof sections;
type ImageField = "coverImageUrl" | "avatarImageUrl";
type UploadTarget = ImageField | "brand";
const uploadTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const imageFields: { key: ImageField; label: string; detail: string }[] = [
  { key: "coverImageUrl", label: "首页封面", detail: "首页横幅使用，建议选用横向图片。" },
  { key: "avatarImageUrl", label: "网站头像", detail: "网站标识使用，建议选用正方形图片。" },
];
const socialContacts = [
  { label: "WhatsApp", urlField: "whatsappUrl", enabledField: "whatsappEnabled" },
  { label: "Telegram", urlField: "telegramUrl", enabledField: "telegramEnabled" },
  { label: "Facebook", urlField: "facebookUrl", enabledField: "facebookEnabled" },
] as const;

function socialContactError(value: string, enabled: boolean): string {
  const url = value.trim();
  if (!url) return enabled ? "请先填写联系链接，再开启前台显示。" : "";
  return isSafeSocialUrl(url) ? "" : "请输入完整的 https:// 或 http:// 联系链接。";
}
class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
function Reauthenticate({ signInPath }: { signInPath: string }) { return <a className="cms-reauth" href={signInPath} target="_top">重新登入 ↗</a>; }
const categoryNames = { All: "All", Update: "Update", New: "New" };
const publicationLabels = { published: "已上架", scheduled: "待上线", draft: "草稿" } as const;
type PublicationStatus = keyof typeof publicationLabels;
const expiryFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const malaysiaOffset = 8 * 60 * 60 * 1000;
function malaysiaDateTimeInput(start: number | null | undefined): string {
  return isValidPromotionStart(start) ? new Date(start + malaysiaOffset).toISOString().slice(0, -8) : "";
}
const emptyBrand = (): Brand => ({ id: "", name: "", slug: "", category: "All", promotionDays: null, promotionStartsAt: null, promotionExpiresAt: null, tagline: "", description: "", color: "#d3b477", icon: "sparkles", imageUrl: "", featured: false, published: false, sortOrder: 10, link: "" });

function BrandIcon({ value }: { value: string }) {
  const Icon = ({ sparkles: Sparkles, orbit: Orbit, sun: Sun, gamepad: Gamepad2, moon: Moon, triangle: Triangle } as const)[value as "sparkles"] || Sparkles;
  return <Icon size={24} strokeWidth={1.6} />;
}

function publicationStatus(brand: Brand, now = Date.now()): PublicationStatus {
  if (!brand.published) return "draft";
  return isBrandPublished(brand, now) ? "published" : "scheduled";
}

function scheduledPublicationMessage(brand: Brand): string {
  return typeof brand.publishAt === "number"
    ? `已安排 ${expiryFormat.format(brand.publishAt)}（马来西亚时间）自动上线。`
    : "已安排自动上线。";
}

function BrandPromotionCell({ brand, now }: { brand: Brand; now: number }) {
  const start = brand.promotionStartsAt;
  const expiry = brand.promotionExpiresAt;
  const scheduled = brand.published && typeof start === "number" && start > now;
  return <div className="cms-category-cell">
    <span className="cms-category">{categoryNames[effectiveBrandCategory(brand, now)]}</span>
    {brand.category !== "All" && <>
      {scheduled && <small>{brand.category} 等待开始</small>}
      {typeof start === "number" && <small>开始 {expiryFormat.format(start)}</small>}
      {expiry !== null && <small>{expiry <= now ? `${brand.category} 已于 ${expiryFormat.format(expiry)} 到期` : `到期 ${expiryFormat.format(expiry)}`}</small>}
    </>}
  </div>;
}

function imagePreviewUrl(value: string): string {
  const trimmed = value.trim();
  return isSafeImageUrl(trimmed) ? trimmed : "";
}

function ImageUploadButton({ label, uploading, onUpload }: {
  label: string;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  return <div className="cms-secondary cms-file-picker">
    {uploading ? <LoaderCircle size={15} className="cms-spin" aria-hidden="true" /> : <Upload size={15} aria-hidden="true" />}
    <span aria-hidden="true">{uploading ? "正在上传…" : label}</span>
    <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp" aria-label={label} onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) onUpload(file);
    }} />
  </div>;
}

function SettingsImageField({ field, label, detail, value, filename, uploading, onChange, onUpload }: {
  field: ImageField;
  label: string;
  detail: string;
  value: string;
  filename?: string;
  uploading: boolean;
  onChange: (value: string) => void;
  onUpload: (file: File) => void;
}) {
  const [failedSrc, setFailedSrc] = useState("");
  const previewSrc = imagePreviewUrl(value);
  const invalid = Boolean(value.trim() && !previewSrc);
  const avatar = field === "avatarImageUrl";
  const PlaceholderIcon = avatar ? UserRound : ImageIcon;
  return <div className="cms-image-field">
    <div className="cms-image-field-heading"><h3>{label}</h3><p>{detail}</p></div>
    <div className={`cms-image-preview${avatar ? " cms-avatar-preview" : ""}`}>
      {previewSrc && failedSrc !== previewSrc ? <img src={previewSrc} alt={`${label}预览`} referrerPolicy="no-referrer" onError={() => setFailedSrc(previewSrc)} /> :
        <div><PlaceholderIcon size={24} /><span>{previewSrc ? "图片无法加载" : "使用默认图片"}</span></div>}
    </div>
    <div className="cms-image-url">
      <label htmlFor={field}>{label}地址<input id={field} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} value={value} onChange={event => onChange(event.target.value)} placeholder="https://… 或 /images/…" aria-invalid={invalid || undefined} aria-describedby={`${field}-hint`} /></label>
      <small id={`${field}-hint`} className={invalid ? "cms-image-invalid" : undefined}>{invalid ? "请输入 HTTPS 图片地址或以 / 开头的本站图片路径。" : "可粘贴图片地址，也可从设备上传。"}</small>
    </div>
    <div className="cms-image-actions">
      <ImageUploadButton label={`上传${label}`} uploading={uploading} onUpload={onUpload} />
      {value && <button type="button" className="cms-image-clear" onClick={() => { onChange(""); setFailedSrc(""); }}><X size={14} />恢复默认</button>}
    </div>
    {filename && <div className="cms-image-filename" title={filename}><Check size={14} />{filename}</div>}
  </div>;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController();
  const file = body instanceof Blob ? body : null;
  const timer = setTimeout(() => controller.abort(), file ? 60000 : 20000);
  try {
    const response = await fetch(path, { method, headers: method === "GET" ? undefined : { "Content-Type": file ? file.type || "application/octet-stream" : "application/json" }, body: file ?? (body === undefined ? undefined : JSON.stringify(body)), credentials: "same-origin", cache: "no-store", signal: controller.signal });
    const result = await response.json().catch(() => ({ error: "服务器返回了无法读取的内容，请稍后重试。" })) as T & { error?: string };
    if (!response.ok) throw new RequestError(result.error || "操作失败，请重试。", response.status);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("连接超时，请检查网络后重试。");
    throw error;
  } finally { clearTimeout(timer); }
}

function imageUploadError(file: File): string {
  if (!(file.type && file.type !== "application/octet-stream" ? uploadTypes.includes(file.type) : /\.(jpe?g|png|gif|webp)$/i.test(file.name))) {
    return "请选择 JPG、PNG、GIF 或 WebP 图片。";
  }
  return !file.size || file.size > 5 * 1024 * 1024 ? "图片不能为空，每张最多 5 MB。" : "";
}

async function uploadAdminImage(file: File): Promise<string> {
  const validationError = imageUploadError(file);
  if (validationError) throw new Error(validationError);
  const { url } = await request<{ url: string }>("/api/admin/images", "POST", file);
  if (typeof url !== "string" || !isUploadedImageUrl(url)) throw new Error("无法读取上传结果，请重试。");
  return url;
}

export default function AdminClient({ displayName, signInPath }: { displayName: string; signInPath: string }) {
  const { theme, setTheme } = useAdminTheme();
  const [section, setSection] = useState<Section>("brands");
  const { title, description } = sections[section];
  const [brands, setBrands] = useState<Brand[]>([]);
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | PublicationStatus>("all");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [uploading, setUploading] = useState<UploadTarget | null>(null);
  const [imageNames, setImageNames] = useState<Partial<Record<ImageField, string>>>({});
  const [brandPhotoName, setBrandPhotoName] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [promotionStartInput, setPromotionStartInput] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [deleting, setDeleting] = useState<Brand | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const originalEditing = editing ? brands.find(brand => brand.id === editing.id) : undefined;
  const startChanged = Boolean(editing && editing.category !== "All" && promotionStartInput !== malaysiaDateTimeInput(originalEditing?.promotionStartsAt));
  const autoPublishesOnSave = startChanged && Boolean(promotionStartInput) && !originalEditing?.published;
  let publicationHint = "允许品牌显示在前台。";
  if (autoPublishesOnSave) {
    publicationHint = "保存后进入待上线状态，到时首次显示在前台。";
  } else if (editing?.published && originalEditing && publicationStatus(originalEditing, now) === "scheduled") {
    publicationHint = editing.category === "All" || !promotionStartInput
      ? "保存后立即上架。取消勾选可移至草稿。"
      : "等待定时上线。取消勾选并保存可移至草稿。";
  }

  function fail(err: unknown, fallback: string) { setError(err instanceof Error ? err.message : fallback); setSessionExpired(err instanceof RequestError && err.status === 401); }
  async function load() {
    setLoading(true); setError("");
    try {
      const data = await request<{ brands: Brand[]; settings: SiteSettings }>("/api/admin/brands");
      setBrands(data.brands); setSettings(data.settings); setNow(Date.now()); setLoaded(true); setSessionExpired(false);
    } catch (err) { fail(err, "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { if (editing) dialog.current?.showModal(); else dialog.current?.close(); }, [editing]);
  useEffect(() => { if (deleting) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [deleting]);
  useEffect(() => { if (success) { const timer = setTimeout(() => setSuccess(""), 4500); return () => clearTimeout(timer); } }, [success]);
  useEffect(() => {
    const upcoming = brands.flatMap(brand => [brand.publishAt, brand.promotionStartsAt, brand.promotionExpiresAt])
      .filter((boundary): boundary is number => typeof boundary === "number" && boundary > now);
    if (!upcoming.length) return;
    const delay = Math.min(2_147_483_647, Math.max(0, Math.min(...upcoming) - Date.now() + 1));
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [brands, now]);

  function notify(message: string) { setSessionExpired(false); setError(""); setSuccess(message); }
  function openEditor(brand?: Brand) {
    if (busy || !loaded) return;
    setError(""); setBrandPhotoName(""); setNow(Date.now());
    setPromotionStartInput(malaysiaDateTimeInput(brand?.promotionStartsAt));
    setEditing(brand ? { ...brand } : emptyBrand());
  }
  async function saveBrand(event: React.FormEvent) {
    event.preventDefault(); if (!editing || busy) return;
    if (editing.category !== "All" && (!Number.isInteger(editing.promotionDays) || (editing.promotionDays ?? 0) < 1 || (editing.promotionDays ?? 0) > 365)) {
      setError("展示天数请输入 1 至 365 的整数。"); return;
    }
    let promotionStartsAt: number | null = null;
    if (startChanged && promotionStartInput) {
      promotionStartsAt = Date.parse(`${promotionStartInput}+08:00`);
      if (!isValidPromotionStart(promotionStartsAt) || malaysiaDateTimeInput(promotionStartsAt) !== promotionStartInput || promotionStartsAt < Date.now()) {
        setError("请选择未来的开始时间，留空则立即开始。"); return;
      }
    }
    setBusy(true); setError("");
    try {
      const { id: _id, publishAt: _publishAt, promotionExpiresAt: _expires, promotionStartsAt: _starts, scheduledCategory: _scheduledCategory, promotionDays, ...fields } = editing;
      const durationChanged = !originalEditing || originalEditing.category !== editing.category || originalEditing.promotionDays !== promotionDays;
      const payload = {
        ...fields,
        ...(durationChanged ? { promotionDays: editing.category === "All" ? null : promotionDays } : {}),
        ...(startChanged ? { promotionStartsAt } : {}),
        ...(promotionStartsAt !== null && (!originalEditing?.published || editing.published) ? { autoPublishAtStart: true } : {}),
        slug: editing.slug || editing.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      };
      const result = await request<{ brand: Brand }>(editing.id ? `/api/admin/brands/${encodeURIComponent(editing.id)}` : "/api/admin/brands", editing.id ? "PUT" : "POST", payload);
      setBrands(current => [...current.filter(item => item.id !== result.brand.id), result.brand].sort((a, b) => a.sortOrder - b.sortOrder));
      const status = publicationStatus(result.brand);
      setNow(Date.now());
      setEditing(null);
      notify(status === "scheduled" ? scheduledPublicationMessage(result.brand) : status === "published" ? "品牌已保存，前台会显示最新内容。" : "品牌草稿已保存。");
    } catch (err) { fail(err, "保存失败"); }
    finally { setBusy(false); }
  }
  async function toggle(brand: Brand, field: "published" | "featured") {
    if (busy) return; setBusy(true); setError("");
    try {
      const { id: _id, publishAt: _publishAt, promotionExpiresAt: _expires, promotionStartsAt: _starts, scheduledCategory: _scheduledCategory, promotionDays: _days, ...fields } = brand;
      const { brand: saved } = await request<{ brand: Brand }>(`/api/admin/brands/${encodeURIComponent(brand.id)}`, "PUT", { ...fields, [field]: !brand[field] });
      setBrands(current => current.map(item => item.id === saved.id ? saved : item));
      setNow(Date.now());
      const status = publicationStatus(saved);
      notify(field === "featured" ? "精选状态已更新。" : status === "scheduled" ? scheduledPublicationMessage(saved) : status === "published" ? "品牌已上架。" : "品牌已移至草稿。");
    } catch (err) { fail(err, "更新失败"); }
    finally { setBusy(false); }
  }
  async function deleteBrand() {
    if (!deleting || busy) return; setBusy(true); setError("");
    try {
      await request(`/api/admin/brands/${encodeURIComponent(deleting.id)}`, "DELETE");
      setBrands(current => current.filter(brand => brand.id !== deleting.id)); setDeleting(null); notify("品牌已删除。");
    } catch (err) { fail(err, "删除失败"); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (busy) return; setBusy(true); setError("");
    try { await request("/api/auth/logout", "POST", {}); window.location.assign("/login"); }
    catch (err) { fail(err, "退出失败，请重试。"); setBusy(false); }
  }
  function changeImage(field: ImageField, value: string) {
    setSettings(current => current ? { ...current, [field]: value } : current);
    setImageNames(current => ({ ...current, [field]: undefined }));
  }
  async function uploadPhoto(target: UploadTarget, file: File) {
    if (busy || (target === "brand" ? !editing : !settings)) return;
    setError(""); setSuccess(""); setSessionExpired(false);
    setBusy(true); setUploading(target);
    try {
      const url = await uploadAdminImage(file);
      if (target === "brand") {
        setEditing(current => current && current === editing ? { ...current, imageUrl: url } : current);
        setBrandPhotoName(file.name);
      } else {
        setSettings(current => current ? { ...current, [target]: url } : current);
        setImageNames(current => ({ ...current, [target]: file.name }));
        notify("已上传，保存设置后生效。");
      }
    } catch (err) { fail(err, "上传图片失败，请重试。"); }
    finally { setUploading(null); setBusy(false); }
  }
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault(); if (!settings || busy) return;
    const invalidImage = imageFields.find(({ key }) => settings[key]?.trim() && !imagePreviewUrl(settings[key]));
    if (invalidImage) { setSuccess(""); setSessionExpired(false); setError(`${invalidImage.label}地址格式不正确，请输入 HTTPS 地址或本站图片路径。`); return; }
    const invalidContact = socialContacts.find(({ urlField, enabledField }) => socialContactError(settings[urlField] || "", Boolean(settings[enabledField])));
    if (invalidContact) {
      setSuccess(""); setSessionExpired(false);
      setError(`${invalidContact.label} ${socialContactError(settings[invalidContact.urlField] || "", Boolean(settings[invalidContact.enabledField]))}`);
      return;
    }
    setBusy(true); setError("");
    try { const result = await request<{ settings: SiteSettings }>("/api/admin/settings", "PUT", settings); setSettings(result.settings); notify("网站设置已保存。"); }
    catch (err) { fail(err, "保存失败"); }
    finally { setBusy(false); }
  }

  const visibleBrands = brands.filter(brand => `${brand.name} ${brand.tagline}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || publicationStatus(brand, now) === filter)).sort((a, b) => a.sortOrder - b.sortOrder);
  const publishedBrands = brands.filter(brand => isBrandPublished(brand, now));
  const draftCount = brands.filter(brand => !brand.published).length;
  const scheduledCount = brands.length - draftCount - publishedBrands.length;

  return <div className="cms-shell" data-admin-theme={theme}>
    <NotesActivity request={request} />
    <aside className="cms-sidebar">
      <a href="/" className="cms-logo"><span className="cms-logo-symbol">✳</span>{settings?.name || "365freebonus"}<span className="cms-logo-dot">.</span></a>
      <span className="cms-workspace-label">CONTENT WORKSPACE</span>
      <nav aria-label="后台导航">
        <button className={section === "brands" ? "active" : ""} aria-current={section === "brands" ? "page" : undefined} onClick={() => setSection("brands")}><LayoutGrid size={19} />{sections.brands.title}<span>{brands.length}</span></button>
        <button className={section === "settings" ? "active" : ""} aria-current={section === "settings" ? "page" : undefined} onClick={() => setSection("settings")}><Settings2 size={19} />{sections.settings.title}</button>
        <button className={section === "notices" ? "active" : ""} aria-current={section === "notices" ? "page" : undefined} title={sections.notices.title} onClick={() => setSection("notices")}><Megaphone size={19} />{sections.notices.title}</button>
        <button className={section === "telegram" ? "active" : ""} aria-current={section === "telegram" ? "page" : undefined} title={sections.telegram.title} onClick={() => setSection("telegram")}><Send size={19} />{sections.telegram.title}</button>
        <button className={section === "notes" ? "active" : ""} aria-current={section === "notes" ? "page" : undefined} title={sections.notes.title} onClick={() => setSection("notes")}><LockKeyhole size={19} />{sections.notes.title}</button>
        <button className={section === "password" ? "active" : ""} aria-current={section === "password" ? "page" : undefined} title={sections.password.title} onClick={() => setSection("password")}><KeyRound size={19} />{sections.password.title}</button>
        <a href="/" target="_blank" rel="noopener"><Globe size={19} />查看前台<ArrowUpRight size={16} className="cms-nav-arrow" /></a>
      </nav>
      <div className="cms-side-note"><ShieldCheck size={21} /><strong>安全管理空间</strong><p>通过管理员登入保护。品牌与设置保存后即时生效。</p></div>
      <div className="cms-user"><span>{displayName.slice(0, 1).toUpperCase()}</span><div><strong>{displayName}</strong><small>网站管理</small></div><button disabled={busy} onClick={logout} aria-label="退出登录"><LogOut size={16} /></button></div>
    </aside>

    <main className="cms-main">
      <header className="cms-topbar"><div className="cms-breadcrumb"><span className="cms-breadcrumb-parent">工作空间</span><ChevronRight size={14} /><span>{title}</span></div><div className="cms-topbar-actions"><AdminThemeToggle theme={theme} onChange={setTheme} /><a className="cms-preview-link" href="/" target="_blank" rel="noopener">预览网站<ExternalLink size={14} /></a></div></header>
      <div className="cms-content">
        <div className="cms-page-heading"><div><span className="cms-eyebrow">YOUR DIRECTORY, YOUR WAY</span><h1>{title}<span>↗</span></h1><p>{description}</p></div>{section === "brands" && <button className="cms-primary" onClick={() => openEditor()} disabled={loading || !loaded || busy}><Plus size={18} />添加品牌</button>}</div>
        {error && !editing && !deleting && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <Reauthenticate signInPath={signInPath} />}<button onClick={() => setError("")} aria-label="关闭错误"><X size={17} /></button></div>}
        {success && <div className="cms-alert cms-success" role="status"><Check size={18} /><span>{success}</span></div>}
        {section === "telegram" ? <TelegramGroupSettings request={request} signInPath={signInPath} /> :
        section === "notes" ? <SecureNotes request={request} signInPath={signInPath} /> :
        section === "password" ? <PasswordSettings request={request} signInPath={signInPath} /> :
        section === "notices" ? <PopupNoticeSettings request={request} signInPath={signInPath} uploadImage={uploadAdminImage} UploadButton={ImageUploadButton} /> :
        loading ? <div className="cms-loading"><LoaderCircle size={27} /><p>正在加载你的内容…</p></div> : !loaded ? <div className="cms-empty"><CircleHelp size={29} /><h3>暂时无法加载内容</h3><p>请重新加载，确认服务器中的最新资料。</p><button className="cms-secondary" onClick={load}>重新加载</button></div> : section === "brands" ? <>
          <section className="cms-stats" aria-label="品牌统计"><div><span>全部品牌<LayoutGrid size={18} /></span><strong>{brands.length.toString().padStart(2, "0")}</strong><small>完整内容目录</small></div><div><span>已上架<Eye size={18} /></span><strong>{publishedBrands.length.toString().padStart(2, "0")}<i /></strong><small>{scheduledCount ? `${scheduledCount} 个品牌待上线` : "显示在前台的品牌"}</small></div><div><span>首页精选<Sparkles size={18} /></span><strong>{publishedBrands.filter(brand => brand.featured).length.toString().padStart(2, "0")}</strong><small>已上架的精选品牌</small></div><div><span>草稿<FileText size={18} /></span><strong>{draftCount.toString().padStart(2, "0")}</strong><small>准备好后再公开</small></div></section>
          <section className="cms-brand-panel"><div className="cms-panel-tools"><div className="cms-tabs" role="group" aria-label="筛选状态">{([["all", "全部品牌"], ["published", "已上架"], ["scheduled", "待上线"], ["draft", "草稿"]] as const).map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}</div><label className="cms-search"><Search size={17} /><input aria-label="搜索品牌" placeholder="搜索品牌名称…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
          <div className="cms-table-scroll"><table className="cms-table"><thead><tr><th>品牌名称</th><th>分类</th><th>状态</th><th>精选</th><th>排序</th><th className="cms-actions-heading">操作</th></tr></thead><tbody>{visibleBrands.map(brand => {
            const status = publicationStatus(brand, now);
            return <tr key={brand.id}><td><div className="cms-brand-cell"><span className="cms-brand-icon" style={{ background: `${brand.color}18`, color: brand.color }}>{brand.imageUrl ? <img src={brand.imageUrl} alt="" /> : <BrandIcon value={brand.icon} />}</span><div><strong>{brand.name}</strong><small>{brand.tagline || brand.slug}</small></div></div></td><td>
            <BrandPromotionCell brand={brand} now={now} />
          </td><td><button disabled={busy} className={`cms-status ${status}`} onClick={() => toggle(brand, "published")}
            title={status === "scheduled" ? "取消定时上线并移至草稿" : status === "published" ? "移至草稿" : "立即上架"}>
              <i />{publicationLabels[status]}
            </button></td><td><button disabled={busy} className={`cms-feature ${brand.featured ? "selected" : ""}`} onClick={() => toggle(brand, "featured")} aria-label={brand.featured ? `取消精选 ${brand.name}` : `精选 ${brand.name}`}><Sparkles size={17} /></button></td><td><span className="cms-order">{brand.sortOrder}</span></td><td><div className="cms-row-actions"><button disabled={busy} onClick={() => openEditor(brand)} aria-label={`编辑 ${brand.name}`}><Pencil size={16} /></button><button disabled={busy} className="cms-delete" onClick={() => { setError(""); setDeleting(brand); }} aria-label={`删除 ${brand.name}`}><Trash2 size={16} /></button></div></td></tr>;
          })}</tbody></table></div>
          {visibleBrands.length === 0 && <div className="cms-empty"><Search size={29} /><h3>{query || filter !== "all" ? "没有找到符合条件的品牌" : "你的第一个品牌，从这里开始"}</h3><p>{query || filter !== "all" ? "试试其他关键词或状态。" : "添加品牌，填写内容，再上架到前台。"}</p>{!query && filter === "all" && <button className="cms-primary" onClick={() => openEditor()}><Plus size={16} />添加品牌</button>}</div>}
          <div className="cms-panel-footer"><span>显示 {visibleBrands.length} / {brands.length} 个品牌</span><small><CircleHelp size={14} />排序数字越小，显示越靠前</small></div></section>
          <p className="cms-footnote">内容由你管理 · 演示品牌仅用于展示页面效果</p>
        </> : settings ? <form className="cms-settings-form" onSubmit={saveSettings}><fieldset disabled={busy}><section className="cms-settings-panel"><div><h2>品牌与首页</h2><p>这里的内容会显示在前台首页。</p></div><div className="cms-settings-fields"><label>网站名称<input required maxLength={40} value={settings.name} onChange={event => setSettings({ ...settings, name: event.target.value })} /></label><label>首页主标题<textarea required rows={3} maxLength={120} value={settings.headline} onChange={event => setSettings({ ...settings, headline: event.target.value })} /><small>每行显示一段标题，换行后会依次播放标题动画。</small></label><label>首页介绍<textarea rows={4} maxLength={600} value={settings.description} onChange={event => setSettings({ ...settings, description: event.target.value })} /></label></div></section>
          <section className="cms-settings-panel"><div><h2>首页封面与头像</h2><p>上传图片或输入图片地址。保存后更新前台，留空则使用默认图片。</p></div><div className="cms-settings-fields cms-image-fields">
            {imageFields.map(({ key, label, detail }) => <SettingsImageField key={key} field={key} label={label} detail={detail} value={settings[key] || ""} filename={imageNames[key]} uploading={uploading === key} onChange={value => changeImage(key, value)} onUpload={file => uploadPhoto(key, file)} />)}
            <p className="cms-image-form-hint">支持 JPG、PNG、GIF、WebP，每张最多 5 MB。</p>
          </div></section>
          <section className="cms-settings-panel">
            <div><h2>公告与联系</h2><p>保持首页消息及时、清晰。</p></div>
            <div className="cms-settings-fields">
              <label>顶部公告
                <textarea rows={4} maxLength={250} value={settings.announcement} onChange={event => setSettings({ ...settings, announcement: event.target.value })} />
                <small>每行一条公告。上一条滚完后会间隔片刻，再播放下一条。留空时不显示公告栏。</small>
              </label>
              <label>联系链接<input type="url" placeholder="https://..." maxLength={1000} value={settings.contactUrl} onChange={event => setSettings({ ...settings, contactUrl: event.target.value })} /><small>可填写你的官方联系页面，留空则隐藏。</small></label>
            </div>
          </section>
          <section className="cms-settings-panel">
            <div><h2>社交联系</h2><p>填写联系链接，开启后在首页显示对应入口。</p></div>
            <div className="cms-settings-fields cms-social-contacts">
              {socialContacts.map(({ label, urlField, enabledField }) => {
                const enabled = Boolean(settings[enabledField]);
                const value = settings[urlField] || "";
                const validationError = socialContactError(value, enabled);
                const hintId = `${urlField}-hint`;
                return <div className="cms-social-contact" key={urlField}>
                  <div className="cms-social-heading">
                    <h3>{label}</h3>
                    <label className="cms-social-switch">
                      <input type="checkbox" role="switch" aria-label={`${label} 前台显示`} checked={enabled}
                        onChange={event => setSettings({ ...settings, [enabledField]: event.target.checked })} />
                      <span aria-hidden="true">{enabled ? "开启" : "关闭"}</span>
                    </label>
                  </div>
                  <label htmlFor={urlField}>{label} 联系链接
                    <input id={urlField} type="url" inputMode="url" autoComplete="off" spellCheck={false}
                      placeholder="https://..." maxLength={2048} required={enabled} value={value}
                      aria-invalid={Boolean(validationError) || undefined} aria-describedby={hintId}
                      onChange={event => setSettings({ ...settings, [urlField]: event.target.value })} />
                  </label>
                  <p id={hintId} className={validationError ? "cms-social-error" : "cms-social-hint"}>
                    {validationError || (enabled ? "保存设置后，前台将显示这个联系入口。" : "已关闭，前台隐藏这个联系入口。")}
                  </p>
                </div>;
              })}
            </div>
          </section>
          <div className="cms-settings-save"><span>保存后，刷新前台即可查看最新内容。</span><button disabled={busy} className="cms-primary" type="submit">{busy ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}保存设置</button></div></fieldset></form> : <div className="cms-empty"><p>暂时无法加载网站设置。</p><button className="cms-secondary" onClick={load}>重新加载</button></div>}
      </div>
    </main>

    <dialog ref={dialog} className="cms-dialog" onCancel={event => { if (busy) event.preventDefault(); else setEditing(null); }} onClick={event => { if (event.target === dialog.current && !busy) setEditing(null); }}>
      {editing && <form onSubmit={saveBrand}><div className="cms-dialog-heading"><div><span className="cms-eyebrow">BRAND EDITOR</span><h2>{editing.id ? "编辑品牌" : "添加新品牌"}</h2></div><button type="button" disabled={busy} onClick={() => setEditing(null)} aria-label="关闭编辑"><X size={21} /></button></div>
      <fieldset disabled={busy} className="cms-dialog-body">{error && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <Reauthenticate signInPath={signInPath} />}</div>}<div className="cms-editor-preview"><span className="cms-brand-icon" style={{ background: `${editing.color}18`, color: editing.color }}>{editing.imageUrl ? <img src={editing.imageUrl} alt="品牌图片预览" /> : <BrandIcon value={editing.icon} />}</span><div><strong>{editing.name || "你的品牌名称"}</strong><small>{editing.tagline || "一句话，让品牌被记住。"}</small></div></div>
      <div className="cms-form-grid"><label>品牌名称 <em>*</em><input autoFocus required maxLength={80} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} placeholder="例如 NOVA PLAY" /></label><label>唯一标识<input pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} value={editing.slug} onChange={event => setEditing({ ...editing, slug: event.target.value })} placeholder="例如 nova-play" /><small>小写字母、数字及短横线。</small></label><label>品牌分类<select value={editing.category} onChange={event => {
        const category = event.target.value as Brand["category"];
        setEditing({ ...editing, category, promotionDays: category === "All" ? null : editing.promotionDays ?? DEFAULT_PROMOTION_DAYS });
      }}>{Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>All 显示全部品牌，Update / New 按设置天数展示。</small></label><label>显示顺序<input type="number" required min={0} max={99999} value={editing.sortOrder} onChange={event => setEditing({ ...editing, sortOrder: Number(event.target.value) })} /></label>{editing.category !== "All" && <>
        <label className="cms-promotion-days">
          展示天数
          <input type="number" required min={1} max={365} step={1} value={editing.promotionDays ?? ""}
            onChange={event => setEditing({ ...editing, promotionDays: event.target.value === "" ? null : Number(event.target.value) })} />
          <small>从开始时间起计，到期后仅显示在 All。</small>
        </label>
        <label className="cms-promotion-start">
          开始时间（马来西亚 UTC+8）
          <input type="datetime-local" value={promotionStartInput} onChange={event => setPromotionStartInput(event.target.value)} />
          <small>留空立即开始推广。草稿设置新时间并保存后，到时自动上线。已上架品牌在推广开始前继续显示在 All。</small>
        </label>
        {editing.promotionExpiresAt !== null && <p className="cms-wide cms-promotion-note">
          {editing.promotionExpiresAt <= now
            ? `已于 ${expiryFormat.format(editing.promotionExpiresAt)} 到期，目前仅在 All 显示。`
            : `当前设置于 ${expiryFormat.format(editing.promotionExpiresAt)} 到期。`}
          修改开始时间或展示天数后，将重新计算到期时间。
        </p>}
      </>}
      <label className="cms-wide">一句话介绍<input required maxLength={160} value={editing.tagline} onChange={event => setEditing({ ...editing, tagline: event.target.value })} placeholder="介绍这个品牌的独特之处" /></label><label className="cms-wide">详细介绍<textarea rows={4} maxLength={2000} value={editing.description} onChange={event => setEditing({ ...editing, description: event.target.value })} /></label><label>品牌图标<select value={editing.icon} onChange={event => setEditing({ ...editing, icon: event.target.value })}>{[["sparkles", "星光"], ["orbit", "轨道"], ["sun", "太阳"], ["gamepad", "游戏"], ["moon", "月亮"], ["triangle", "三角"]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>未填写图片时使用。</small></label><label>主题颜色<div className="cms-color-field"><input type="color" value={/^#[0-9a-f]{6}$/i.test(editing.color) ? editing.color : "#d3b477"} onChange={event => setEditing({ ...editing, color: event.target.value })} aria-label="选择主题颜色" /><input required pattern="#[0-9a-fA-F]{6}" maxLength={7} value={editing.color} onChange={event => setEditing({ ...editing, color: event.target.value })} /></div></label><div className="cms-wide cms-brand-photo">
        <div className="cms-image-actions"><ImageUploadButton label="上传品牌照片" uploading={uploading === "brand"} onUpload={file => uploadPhoto("brand", file)} /></div>
        <small className="cms-photo-hint">支持 JPG、PNG、GIF、WebP，每张最多 5 MB。上传后点击「保存品牌」生效。</small>
        {brandPhotoName && <div className="cms-image-filename" role="status"><Check size={14} />已上传 {brandPhotoName}</div>}
        <label>品牌图片 URL<input type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={1000} value={editing.imageUrl} onChange={event => { setEditing({ ...editing, imageUrl: event.target.value }); setBrandPhotoName(""); }} placeholder="也可输入公开的图片地址" /></label>
      </div><label className="cms-wide">品牌链接<input type="url" maxLength={1000} value={editing.link} onChange={event => setEditing({ ...editing, link: event.target.value })} placeholder="https://..." /><small>可选，留空时仅展示详情。</small></label></div>
      <div className="cms-switches"><label>
        <span><strong>{autoPublishesOnSave ? "定时上线" : "上架品牌"}</strong><small>{publicationHint}</small></span>
        <input type="checkbox" checked={editing.published || autoPublishesOnSave} disabled={autoPublishesOnSave}
          onChange={event => setEditing({ ...editing, published: event.target.checked })} />
      </label><label><span><strong>首页精选</strong><small>在首页精选区域展示。</small></span><input type="checkbox" checked={editing.featured} onChange={event => setEditing({ ...editing, featured: event.target.checked })} /></label></div></fieldset><div className="cms-dialog-footer"><button disabled={busy} type="button" className="cms-secondary" onClick={() => setEditing(null)}>取消</button><button disabled={busy} type="submit" className="cms-primary">{busy ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}{uploading === "brand" ? "正在上传…" : busy ? "正在保存…" : "保存品牌"}</button></div></form>}
    </dialog>
    <dialog ref={deleteDialog} className="cms-confirm cms-delete-dialog" aria-labelledby="delete-title" onCancel={event => { if (busy) event.preventDefault(); else setDeleting(null); }}>
      {deleting && <><span className="cms-confirm-icon"><Trash2 size={23} /></span><h2 id="delete-title">删除 {deleting.name}？</h2><p>这会永久删除该品牌资料，前台也会同步移除。此操作无法撤销。</p>{error && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <Reauthenticate signInPath={signInPath} />}</div>}<div className="cms-confirm-actions"><button autoFocus disabled={busy} className="cms-secondary" onClick={() => setDeleting(null)}>取消</button><button disabled={busy} className="cms-danger" onClick={deleteBrand}>{busy ? "正在删除…" : "确认删除"}</button></div></>}
    </dialog>
  </div>;
}
