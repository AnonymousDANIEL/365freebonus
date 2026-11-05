"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, CircleHelp, ExternalLink, Eye, FileText, LayoutGrid, LoaderCircle, Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2, X, Pencil, Globe, LogOut, Orbit, Sun, Gamepad2, Moon, Triangle } from "lucide-react";
import type { Brand, SiteSettings } from "../lib/directory";

type Section = "brands" | "settings";
class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
function Reauthenticate() { return <a className="cms-reauth" href="/login?return_to=%2Fadmin" target="_top">重新登入 ↗</a>; }
const categoryNames = { Gaming: "游戏", Lifestyle: "生活", Entertainment: "娱乐" };
const emptyBrand = (): Brand => ({ id: "", name: "", slug: "", category: "Gaming", tagline: "", description: "", color: "#d3b477", icon: "sparkles", imageUrl: "", featured: false, published: false, sortOrder: 10, link: "" });

function BrandIcon({ value }: { value: string }) {
  const Icon = ({ sparkles: Sparkles, orbit: Orbit, sun: Sun, gamepad: Gamepad2, moon: Moon, triangle: Triangle } as const)[value as "sparkles"] || Sparkles;
  return <Icon size={24} strokeWidth={1.6} />;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { method, headers: method === "GET" ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store", signal: controller.signal });
    const result = await response.json().catch(() => ({ error: "服务器返回了无法读取的内容，请稍后重试。" })) as T & { error?: string };
    if (!response.ok) throw new RequestError(result.error || "操作失败，请重试。", response.status);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("连接超时，请检查网络后重试。");
    throw error;
  } finally { clearTimeout(timer); }
}

export default function AdminClient({ displayName }: { displayName: string }) {
  const [section, setSection] = useState<Section>("brands");
  const [brands, setBrands] = useState<Brand[]>([]);
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [deleting, setDeleting] = useState<Brand | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);

  function fail(err: unknown, fallback: string) { setError(err instanceof Error ? err.message : fallback); setSessionExpired(err instanceof RequestError && err.status === 401); }
  async function load() {
    setLoading(true); setError("");
    try {
      const data = await request<{ brands: Brand[]; settings: SiteSettings }>("/api/admin/brands");
      setBrands(data.brands); setSettings(data.settings); setLoaded(true); setSessionExpired(false);
    } catch (err) { fail(err, "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { if (editing) dialog.current?.showModal(); else dialog.current?.close(); }, [editing]);
  useEffect(() => { if (deleting) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [deleting]);
  useEffect(() => { if (success) { const timer = setTimeout(() => setSuccess(""), 4500); return () => clearTimeout(timer); } }, [success]);

  function notify(message: string) { setSessionExpired(false); setError(""); setSuccess(message); }
  function openEditor(brand?: Brand) { if (busy || !loaded) return; setError(""); setEditing(brand ? { ...brand } : emptyBrand()); }
  async function saveBrand(event: React.FormEvent) {
    event.preventDefault(); if (!editing || busy) return;
    setBusy(true); setError("");
    try {
      const { id: _id, ...fields } = editing;
      const payload = { ...fields, slug: editing.slug || editing.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };
      const result = await request<{ brand: Brand }>(editing.id ? `/api/admin/brands/${encodeURIComponent(editing.id)}` : "/api/admin/brands", editing.id ? "PUT" : "POST", payload);
      setBrands(current => [...current.filter(item => item.id !== result.brand.id), result.brand].sort((a, b) => a.sortOrder - b.sortOrder));
      setEditing(null); notify("品牌已保存，前台会显示最新内容。");
    } catch (err) { fail(err, "保存失败"); }
    finally { setBusy(false); }
  }
  async function toggle(brand: Brand, field: "published" | "featured") {
    if (busy) return; setBusy(true); setError("");
    try {
      const { id: _id, ...fields } = brand;
      const { brand: saved } = await request<{ brand: Brand }>(`/api/admin/brands/${encodeURIComponent(brand.id)}`, "PUT", { ...fields, [field]: !brand[field] });
      setBrands(current => current.map(item => item.id === saved.id ? saved : item)); notify(field === "published" ? (saved.published ? "品牌已上架。" : "品牌已移至草稿。") : "精选状态已更新。");
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
  async function saveSettings(event: React.FormEvent) {
    event.preventDefault(); if (!settings || busy) return; setBusy(true); setError("");
    try { const result = await request<{ settings: SiteSettings }>("/api/admin/settings", "PUT", settings); setSettings(result.settings); notify("网站设置已保存。"); }
    catch (err) { fail(err, "保存失败"); }
    finally { setBusy(false); }
  }

  const visibleBrands = brands.filter(brand => `${brand.name} ${brand.tagline}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "published" ? brand.published : !brand.published))).sort((a, b) => a.sortOrder - b.sortOrder);
  const publishedCount = brands.filter(brand => brand.published).length;

  return <div className="cms-shell">
    <aside className="cms-sidebar">
      <a href="/" className="cms-logo"><span className="cms-logo-symbol">✳</span>{settings?.name || "365freebonus"}<span className="cms-logo-dot">.</span></a>
      <span className="cms-workspace-label">CONTENT WORKSPACE</span>
      <nav aria-label="后台导航">
        <button className={section === "brands" ? "active" : ""} onClick={() => setSection("brands")}><LayoutGrid size={19} />品牌管理<span>{brands.length}</span></button>
        <button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}><Settings2 size={19} />网站设置</button>
        <a href="/" target="_blank" rel="noopener"><Globe size={19} />查看前台<ArrowUpRight size={16} className="cms-nav-arrow" /></a>
      </nav>
      <div className="cms-side-note"><ShieldCheck size={21} /><strong>安全管理空间</strong><p>通过管理员登入保护。品牌与设置保存后即时生效。</p></div>
      <div className="cms-user"><span>{displayName.slice(0, 1).toUpperCase()}</span><div><strong>{displayName}</strong><small>网站管理</small></div><button disabled={busy} onClick={logout} aria-label="退出登录"><LogOut size={16} /></button></div>
    </aside>

    <main className="cms-main">
      <header className="cms-topbar"><div>工作空间<ChevronRight size={14} /><span>{section === "brands" ? "品牌管理" : "网站设置"}</span></div><a href="/" target="_blank" rel="noopener">预览网站<ExternalLink size={14} /></a></header>
      <div className="cms-content">
        <div className="cms-page-heading"><div><span className="cms-eyebrow">YOUR DIRECTORY, YOUR WAY</span><h1>{section === "brands" ? "品牌管理" : "网站设置"}<span>↗</span></h1><p>{section === "brands" ? "在一个地方，管理每个值得被发现的品牌。" : "让首页文字、站名和公告，都保持你的风格。"}</p></div>{section === "brands" && <button className="cms-primary" onClick={() => openEditor()} disabled={loading || !loaded || busy}><Plus size={18} />添加品牌</button>}</div>
        {error && !editing && !deleting && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <Reauthenticate />}<button onClick={() => setError("")} aria-label="关闭错误"><X size={17} /></button></div>}
        {success && <div className="cms-alert cms-success" role="status"><Check size={18} /><span>{success}</span></div>}
        {loading ? <div className="cms-loading"><LoaderCircle size={27} /><p>正在加载你的内容…</p></div> : !loaded ? <div className="cms-empty"><CircleHelp size={29} /><h3>暂时无法加载内容</h3><p>请重新加载，确认服务器中的最新资料。</p><button className="cms-secondary" onClick={load}>重新加载</button></div> : section === "brands" ? <>
          <section className="cms-stats" aria-label="品牌统计"><div><span>全部品牌<LayoutGrid size={18} /></span><strong>{brands.length.toString().padStart(2, "0")}</strong><small>完整内容目录</small></div><div><span>已上架<Eye size={18} /></span><strong>{publishedCount.toString().padStart(2, "0")}<i /></strong><small>显示在前台的品牌</small></div><div><span>首页精选<Sparkles size={18} /></span><strong>{brands.filter(brand => brand.featured && brand.published).length.toString().padStart(2, "0")}</strong><small>已上架的精选品牌</small></div><div><span>草稿<FileText size={18} /></span><strong>{(brands.length - publishedCount).toString().padStart(2, "0")}</strong><small>准备好后再公开</small></div></section>
          <section className="cms-brand-panel"><div className="cms-panel-tools"><div className="cms-tabs" role="group" aria-label="筛选状态">{[["all", "全部品牌"], ["published", "已上架"], ["draft", "草稿"]].map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}</div><label className="cms-search"><Search size={17} /><input aria-label="搜索品牌" placeholder="搜索品牌名称…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
          <div className="cms-table-scroll"><table className="cms-table"><thead><tr><th>品牌名称</th><th>分类</th><th>状态</th><th>精选</th><th>排序</th><th className="cms-actions-heading">操作</th></tr></thead><tbody>{visibleBrands.map(brand => <tr key={brand.id}><td><div className="cms-brand-cell"><span className="cms-brand-icon" style={{ background: `${brand.color}18`, color: brand.color }}>{brand.imageUrl ? <img src={brand.imageUrl} alt="" /> : <BrandIcon value={brand.icon} />}</span><div><strong>{brand.name}</strong><small>{brand.tagline || brand.slug}</small></div></div></td><td><span className="cms-category">{categoryNames[brand.category]}</span></td><td><button disabled={busy} className={`cms-status ${brand.published ? "published" : "draft"}`} onClick={() => toggle(brand, "published")} title="点击切换上下架"><i />{brand.published ? "已上架" : "草稿"}</button></td><td><button disabled={busy} className={`cms-feature ${brand.featured ? "selected" : ""}`} onClick={() => toggle(brand, "featured")} aria-label={brand.featured ? `取消精选 ${brand.name}` : `精选 ${brand.name}`}><Sparkles size={17} /></button></td><td><span className="cms-order">{brand.sortOrder}</span></td><td><div className="cms-row-actions"><button disabled={busy} onClick={() => openEditor(brand)} aria-label={`编辑 ${brand.name}`}><Pencil size={16} /></button><button disabled={busy} className="cms-delete" onClick={() => { setError(""); setDeleting(brand); }} aria-label={`删除 ${brand.name}`}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>
          {visibleBrands.length === 0 && <div className="cms-empty"><Search size={29} /><h3>{query || filter !== "all" ? "没有找到符合条件的品牌" : "你的第一个品牌，从这里开始"}</h3><p>{query || filter !== "all" ? "试试其他关键词或状态。" : "添加品牌，填写内容，再上架到前台。"}</p>{!query && filter === "all" && <button className="cms-primary" onClick={() => openEditor()}><Plus size={16} />添加品牌</button>}</div>}
          <div className="cms-panel-footer"><span>显示 {visibleBrands.length} / {brands.length} 个品牌</span><small><CircleHelp size={14} />排序数字越小，显示越靠前</small></div></section>
          <p className="cms-footnote">内容由你管理 · 演示品牌仅用于展示页面效果</p>
        </> : settings ? <form className="cms-settings-form" onSubmit={saveSettings}><fieldset disabled={busy}><section className="cms-settings-panel"><div><h2>品牌与首页</h2><p>这里的内容会显示在前台首页。</p></div><div className="cms-settings-fields"><label>网站名称<input required maxLength={40} value={settings.name} onChange={event => setSettings({ ...settings, name: event.target.value })} /></label><label>首页小标题<input maxLength={100} value={settings.eyebrow} onChange={event => setSettings({ ...settings, eyebrow: event.target.value })} /><small>显示在首页主标题上方。</small></label><label>首页主标题<textarea required rows={3} maxLength={120} value={settings.headline} onChange={event => setSettings({ ...settings, headline: event.target.value })} /></label><label>首页介绍<textarea rows={4} maxLength={600} value={settings.description} onChange={event => setSettings({ ...settings, description: event.target.value })} /></label></div></section><section className="cms-settings-panel"><div><h2>公告与联系</h2><p>保持首页消息及时、清晰。</p></div><div className="cms-settings-fields"><label>顶部公告<input maxLength={250} value={settings.announcement} onChange={event => setSettings({ ...settings, announcement: event.target.value })} /><small>留空时不显示公告栏。</small></label><label>联系链接<input type="url" placeholder="https://..." maxLength={1000} value={settings.contactUrl} onChange={event => setSettings({ ...settings, contactUrl: event.target.value })} /><small>可填写你的官方联系页面，留空则隐藏。</small></label></div></section><div className="cms-settings-save"><span>保存后，刷新前台即可查看最新内容。</span><button disabled={busy} className="cms-primary" type="submit">{busy ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}保存设置</button></div></fieldset></form> : <div className="cms-empty"><p>暂时无法加载网站设置。</p><button className="cms-secondary" onClick={load}>重新加载</button></div>}
      </div>
    </main>

    <dialog ref={dialog} className="cms-dialog" onCancel={event => { if (busy) event.preventDefault(); else setEditing(null); }} onClick={event => { if (event.target === dialog.current && !busy) setEditing(null); }}>
      {editing && <form onSubmit={saveBrand}><div className="cms-dialog-heading"><div><span className="cms-eyebrow">BRAND EDITOR</span><h2>{editing.id ? "编辑品牌" : "添加新品牌"}</h2></div><button type="button" disabled={busy} onClick={() => setEditing(null)} aria-label="关闭编辑"><X size={21} /></button></div>
      <fieldset disabled={busy} className="cms-dialog-body">{error && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <Reauthenticate />}</div>}<div className="cms-editor-preview"><span className="cms-brand-icon" style={{ background: `${editing.color}18`, color: editing.color }}>{editing.imageUrl ? <img src={editing.imageUrl} alt="品牌图片预览" /> : <BrandIcon value={editing.icon} />}</span><div><strong>{editing.name || "你的品牌名称"}</strong><small>{editing.tagline || "一句话，让品牌被记住。"}</small></div></div>
      <div className="cms-form-grid"><label>品牌名称 <em>*</em><input autoFocus required maxLength={80} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} placeholder="例如 NOVA PLAY" /></label><label>唯一标识<input pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} value={editing.slug} onChange={event => setEditing({ ...editing, slug: event.target.value })} placeholder="例如 nova-play" /><small>小写字母、数字及短横线。</small></label><label>品牌分类<select value={editing.category} onChange={event => setEditing({ ...editing, category: event.target.value as Brand["category"] })}>{Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label} / {value}</option>)}</select></label><label>显示顺序<input type="number" required min={0} max={99999} value={editing.sortOrder} onChange={event => setEditing({ ...editing, sortOrder: Number(event.target.value) })} /></label><label className="cms-wide">一句话介绍<input required maxLength={160} value={editing.tagline} onChange={event => setEditing({ ...editing, tagline: event.target.value })} placeholder="介绍这个品牌的独特之处" /></label><label className="cms-wide">详细介绍<textarea rows={4} maxLength={2000} value={editing.description} onChange={event => setEditing({ ...editing, description: event.target.value })} /></label><label>品牌图标<select value={editing.icon} onChange={event => setEditing({ ...editing, icon: event.target.value })}>{[["sparkles", "星光"], ["orbit", "轨道"], ["sun", "太阳"], ["gamepad", "游戏"], ["moon", "月亮"], ["triangle", "三角"]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><small>未填写图片时使用。</small></label><label>主题颜色<div className="cms-color-field"><input type="color" value={/^#[0-9a-f]{6}$/i.test(editing.color) ? editing.color : "#d3b477"} onChange={event => setEditing({ ...editing, color: event.target.value })} aria-label="选择主题颜色" /><input required pattern="#[0-9a-fA-F]{6}" maxLength={7} value={editing.color} onChange={event => setEditing({ ...editing, color: event.target.value })} /></div></label><label className="cms-wide">品牌图片 URL<input type="url" maxLength={1000} value={editing.imageUrl} onChange={event => setEditing({ ...editing, imageUrl: event.target.value })} placeholder="https://.../brand.png" /><small>填写可公开访问的 HTTPS 图片地址。</small></label><label className="cms-wide">品牌链接<input type="url" maxLength={1000} value={editing.link} onChange={event => setEditing({ ...editing, link: event.target.value })} placeholder="https://..." /><small>可选，留空时仅展示详情。</small></label></div>
      <div className="cms-switches"><label><span><strong>上架品牌</strong><small>允许品牌显示在前台。</small></span><input type="checkbox" checked={editing.published} onChange={event => setEditing({ ...editing, published: event.target.checked })} /></label><label><span><strong>首页精选</strong><small>在首页精选区域展示。</small></span><input type="checkbox" checked={editing.featured} onChange={event => setEditing({ ...editing, featured: event.target.checked })} /></label></div></fieldset><div className="cms-dialog-footer"><button disabled={busy} type="button" className="cms-secondary" onClick={() => setEditing(null)}>取消</button><button disabled={busy} type="submit" className="cms-primary">{busy ? <LoaderCircle size={17} className="cms-spin" /> : <Check size={17} />}{busy ? "正在保存…" : "保存品牌"}</button></div></form>}
    </dialog>
    <dialog ref={deleteDialog} className="cms-confirm cms-delete-dialog" aria-labelledby="delete-title" onCancel={event => { if (busy) event.preventDefault(); else setDeleting(null); }}>
      {deleting && <><span className="cms-confirm-icon"><Trash2 size={23} /></span><h2 id="delete-title">删除 {deleting.name}？</h2><p>这会永久删除该品牌资料，前台也会同步移除。此操作无法撤销。</p>{error && <div className="cms-alert cms-error" role="alert"><span>{error}</span>{sessionExpired && <Reauthenticate />}</div>}<div className="cms-confirm-actions"><button autoFocus disabled={busy} className="cms-secondary" onClick={() => setDeleting(null)}>取消</button><button disabled={busy} className="cms-danger" onClick={deleteBrand}>{busy ? "正在删除…" : "确认删除"}</button></div></>}
    </dialog>
  </div>;
}
