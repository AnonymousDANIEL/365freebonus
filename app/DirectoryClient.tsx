'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ArrowRight, Search, X, Heart, Gamepad2, Sparkles, Orbit, Sun, Moon, Triangle, ChevronDown, SlidersHorizontal, LayoutGrid, Bookmark, Globe2, Compass, ExternalLink, Check, Zap, Layers, MoveUpRight, HelpCircle } from 'lucide-react';
import AnnouncementTicker from './components/AnnouncementTicker';
import BrandScene from './components/BrandScene';
import GiftOrbit from './components/GiftOrbit';
import MalaysiaClock from './components/MalaysiaClock';
import RandomBrandPicker from './components/RandomBrandPicker';
import AcceptedMethods from './components/AcceptedMethods';
import SocialContacts from './components/SocialContacts';
import './components/hero-entrance.css';
import './components/random-pick-result.css';
import { defaultAvatarImageUrl, defaultCoverImageUrl, defaultGiftOpeningPlateUrl, isDefaultGiftCover } from './lib/brand-media';
import { effectiveBrandCategory, isSafeSocialUrl } from './lib/directory';
import type { Brand, DirectoryData } from './lib/directory';

type Lang = 'EN' | 'BM' | '中文';
const clockLabels: Record<Lang, string> = {
  EN: 'Malaysia time',
  BM: 'Waktu Malaysia',
  '中文': '马来西亚时间',
};
const words = {
  EN: {collection:'The collection',how:'How it works',saved:'Saved',explore:'Explore brands',intro:"Explore bonus offers, discover new brands and keep your favourites close.",browse:'Find your next favourite.',sub:'Good discoveries deserve a place of their own. Make this one yours.',all:'All brands',search:'Search a brand or interest…',sort:'Featured first',az:'Name: A–Z',view:'Explore brand',result:'brands to discover',empty:'No discoveries here. Yet.',emptyText:'Try another search or category to find something new.',clear:'Reset filters',featured:'THE SPOTLIGHT',editor:'Handpicked. Worth a closer look.',favorite:'Your saved collection',noSaved:'Tap the heart on any brand to start your collection.',about:'About this brand',visit:'Visit website',close:'Back to exploring',demo:'DEMO COLLECTION',demoText:'Fictional brands for preview',footer:'A little less noise. A lot more discovery.',guide:'Your next favourite is three steps away.',one:'Explore the collection',oneText:'Browse by category, follow your curiosity, or search for something specific.',two:'Get a closer look',twoText:'Open a brand profile to discover its story and what makes it different.',three:'Make it your own',threeText:'Save the brands you love and return to them whenever inspiration strikes.',faqKicker:"YOUR BONUS GUIDE",faq:"More bonuses. More to explore.",faq1:"How do I explore free bonus offers?",answer1:"Browse All or search for a brand that catches your eye. Open its profile to see more, then choose Visit website when a link is available.",faq2:"Where can I find New and Update brands?",answer2:"Choose New or Update to explore brands with those highlights. For the full collection, All brings every brand together in one place.",faq3:"How do I keep my favourites close?",answer3:"Tap the heart on a brand, then open Saved to find it again. No account is needed. Your favourites stay in this browser on this device. Choose All and clear your search to see every saved brand.",latest:'A fresh perspective, every visit.',latestText:'A space for what’s new, what’s different, and what could become your next favourite.',back:'Back to top',dashboard:'Management',details:'Brand profile',category:'Category',spotlight:'SPOTLIGHT',contact:'Get in touch',contactText:'Contact details have not been added yet. The site owner can set a contact link in the dashboard.'},
  BM: {collection:'Koleksi',how:'Cara ia berfungsi',saved:'Disimpan',explore:'Terokai jenama',intro:"Terokai tawaran bonus, temui jenama baharu dan simpan kegemaran anda.",browse:'Temui kegemaran anda.',sub:'Penemuan yang baik layak mendapat tempat tersendiri.',all:'Semua jenama',search:'Cari jenama atau minat…',sort:'Pilihan utama',az:'Nama: A–Z',view:'Terokai jenama',result:'jenama untuk diterokai',empty:'Tiada hasil. Buat masa ini.',emptyText:'Cuba carian atau kategori lain.',clear:'Tetapkan semula',featured:'PILIHAN UTAMA',editor:'Dipilih untuk anda.',favorite:'Koleksi simpanan anda',noSaved:'Tekan ikon hati untuk menyimpan jenama.',about:'Tentang jenama',visit:'Lawati laman',close:'Kembali meneroka',demo:'KOLEKSI DEMO',demoText:'Jenama rekaan untuk pratonton',footer:'Kurang gangguan. Lebih penemuan.',guide:'Tiga langkah ke kegemaran baharu.',one:'Terokai koleksi',oneText:'Pilih kategori atau cari sesuatu yang khusus.',two:'Lihat dengan lebih dekat',twoText:'Buka profil jenama untuk mengetahui kisahnya.',three:'Jadikan milik anda',threeText:'Simpan jenama yang anda suka untuk dilihat semula.',faqKicker:"PANDUAN BONUS ANDA",faq:"Lebih bonus. Lebih pilihan.",faq1:"Bagaimana saya meneroka tawaran bonus percuma?",answer1:"Lihat All atau cari jenama yang menarik perhatian anda. Buka profilnya untuk mengetahui lebih lanjut, kemudian pilih Lawati laman jika pautan tersedia.",faq2:"Di mana saya boleh mencari jenama New dan Update?",answer2:"Pilih New atau Update untuk meneroka jenama dengan label tersebut. Untuk melihat koleksi penuh, All menghimpunkan semua jenama di satu tempat.",faq3:"Bagaimana saya menyimpan jenama kegemaran?",answer3:"Tekan ikon hati pada jenama, kemudian buka Disimpan untuk melihatnya semula. Akaun tidak diperlukan. Kegemaran anda disimpan dalam pelayar pada peranti ini. Pilih All dan kosongkan carian untuk melihat semua jenama yang disimpan.",latest:'Perspektif baharu, setiap lawatan.',latestText:'Ruang untuk sesuatu yang baharu dan berbeza.',back:'Kembali ke atas',dashboard:'Pengurusan',details:'Profil jenama',category:'Kategori',spotlight:'PILIHAN',contact:'Hubungi kami',contactText:'Maklumat hubungan belum ditambah. Pemilik boleh menetapkannya di papan pemuka.'},
  '中文': {collection:'品牌目录',how:'使用指南',saved:'我的收藏',explore:'探索品牌',intro:"发现免费优惠，探索更多品牌，把心动之选随手收藏。",browse:'发现你的下一个心头好。',sub:'值得发现的品牌，都值得一个专属位置。',all:'全部品牌',search:'搜索品牌或感兴趣的内容…',sort:'精选优先',az:'名称 A–Z',view:'查看品牌',result:'个品牌等你发现',empty:'暂时没有找到相关品牌',emptyText:'换个关键词或分类，再探索一下。',clear:'重置筛选',featured:'本期精选',editor:'精心挑选，值得细看。',favorite:'你的品牌收藏',noSaved:'点击品牌的爱心，即可加入收藏。',about:'品牌介绍',visit:'访问网站',close:'继续探索',demo:'演示品牌目录',demoText:'以下为虚构品牌，仅供预览',footer:'少一点喧嚣，多一点发现。',guide:'三步找到你的新喜好。',one:'浏览品牌目录',oneText:'按照分类浏览，或直接搜索你感兴趣的内容。',two:'进一步了解',twoText:'打开品牌详情，了解品牌故事和特色。',three:'收藏你的喜爱',threeText:'将感兴趣的品牌收藏，随时回来查看。',faqKicker:"优惠探索指南",faq:"好优惠，一起探索。",faq1:"如何探索免费优惠？",answer1:"从 All 浏览全部品牌，或直接搜索你的心动之选。打开品牌详情了解更多；如有网站链接，点击「访问网站」即可继续探索。",faq2:"哪里可以找到 New 和 Update 品牌？",answer2:"选择 New 或 Update，查看带有相应标签的品牌。想一次看完所有选择，切回 All 就能浏览完整品牌目录。",faq3:"怎样留住喜欢的品牌？",answer3:"点击品牌的爱心，再到「我的收藏」就能找到它，无需注册账号。收藏保存在当前设备的浏览器中。选择 All 并清空搜索，即可查看全部已收藏品牌。",latest:'每次到访，都有新的视角。',latestText:'在这里探索新鲜、独特、值得留意的品牌。',back:'回到顶部',dashboard:'管理后台',details:'品牌详情',category:'品牌分类',spotlight:'精选',contact:'联系我们',contactText:'暂未设置联系方式。站点所有者可在后台添加联系链接。'}
};
const brandIcons: Record<string, typeof Sparkles> = { sparkles:Sparkles, orbit:Orbit, sun:Sun, gamepad:Gamepad2, moon:Moon, triangle:Triangle };
function Mark({className=''}:{className?:string}) { return <span className={`brandmark ${className}`} aria-hidden="true"><span></span><span></span><span></span></span>; }
function BrandArtwork({brand,large=false}:{brand:Brand,large?:boolean}) {
  const Icon=brandIcons[brand.icon]||Sparkles;
  return <div className={`brand-art art-${brand.icon} ${large?'art-large':''}${brand.imageUrl?' has-brand-image':''}`} style={{'--brand-color':brand.color} as React.CSSProperties}>
    {brand.imageUrl ? <img src={brand.imageUrl} alt={brand.name} loading="lazy" /> : <><div className="art-grid"/><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><div className="art-orbit orbit-three"/><div className="art-emblem"><Icon strokeWidth={1.1}/></div><span className="art-word">{brand.name.split(' ')[0]}</span><span className="art-coordinate">NX / {String(brand.sortOrder+1).padStart(2,'0')}</span><span className="art-spark">✦</span></>}
  </div>;
}

export default function DirectoryClient({initialData}:{initialData:DirectoryData}) {
 const {settings,brands}=initialData;
 const avatarImageUrl = settings.avatarImageUrl || defaultAvatarImageUrl;
 const hasDefaultGift = isDefaultGiftCover(settings.coverImageUrl);
 const [lang,setLang]=useState<Lang>('EN'); const t=words[lang];
 const [query,setQuery]=useState(''); const [category,setCategory]=useState('All'); const [sort,setSort]=useState('featured');
 const [promotionNow, setPromotionNow] = useState(0);
 const [saved,setSaved]=useState<string[]>([]); const [savedReady,setSavedReady]=useState(false); const [onlySaved,setOnlySaved]=useState(false);
 const [active,setActive]=useState<Brand|null>(null); const [info,setInfo]=useState(false); const [faq,setFaq]=useState<number|null>(0);
 const [randomPick, setRandomPick] = useState<{ id: string } | null>(null);
 const closeRef=useRef<HTMLButtonElement>(null); const previousFocus=useRef<HTMLElement|null>(null);
 useEffect(() => {
   let timer: number | undefined;
   const refresh = () => {
     window.clearTimeout(timer);
     const now = Date.now();
     setPromotionNow(now);
     const nextDeadline = brands.reduce((next, brand) => {
       const deadline = brand.promotionExpiresAt;
       return (brand.category === 'Update' || brand.category === 'New')
         && typeof deadline === 'number' && Number.isFinite(deadline) && deadline > now
         ? Math.min(next, deadline) : next;
     }, Infinity);
     if (Number.isFinite(nextDeadline)) {
       timer = window.setTimeout(refresh, Math.min(nextDeadline - now, 2_147_483_647));
     }
   };
   refresh();
   document.addEventListener('visibilitychange', refresh);
   window.addEventListener('focus', refresh);
   return () => {
     window.clearTimeout(timer);
     document.removeEventListener('visibilitychange', refresh);
     window.removeEventListener('focus', refresh);
   };
 }, [brands]);
 useEffect(()=>{try {const s=JSON.parse(localStorage.getItem('365fb-saved')||'[]');setSaved(Array.isArray(s)?s.filter(x=>typeof x==='string'):[]);const l=localStorage.getItem('365fb-language');if(l==='EN'||l==='BM'||l==='中文')setLang(l);}catch{}setSavedReady(true);},[]);
 useEffect(()=>{if(savedReady)try{localStorage.setItem('365fb-saved',JSON.stringify(saved));}catch{}},[saved,savedReady]);
 useEffect(()=>{try{localStorage.setItem('365fb-language',lang);}catch{}document.documentElement.lang=lang==='中文'?'zh':lang==='BM'?'ms':'en';},[lang]);
 useEffect(()=>{if(!active&&!info)return;previousFocus.current=document.activeElement as HTMLElement;document.body.style.overflow='hidden';closeRef.current?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setActive(null);setInfo(false);}if(e.key==='Tab'){const el=document.querySelector('.detail-modal');const items=el?.querySelectorAll<HTMLElement>('button,a[href]');if(!items?.length)return;const first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener('keydown',key);return()=>{document.body.style.overflow='';document.removeEventListener('keydown',key);previousFocus.current?.focus();};},[active,info]);
 const toggleSaved=(id:string)=>setSaved(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
 const filtered=useMemo(()=>brands.filter(b=>(category==='All'||effectiveBrandCategory(b, promotionNow)===category)&&(!onlySaved||saved.includes(b.id))&&`${b.name} ${b.tagline} ${effectiveBrandCategory(b, promotionNow)}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==='az'?a.name.localeCompare(b.name):Number(b.featured)-Number(a.featured)||a.sortOrder-b.sortOrder),[brands,category,onlySaved,saved,query,sort,promotionNow]);
 const featured=brands.filter(b=>b.featured).slice(0,3);
 const jump=(id:string)=>{document.getElementById(id)?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};
 const showSaved=()=>{setOnlySaved(s=>!s);jump('collection');};
 const revealRandomPick = (id: string) => {
   if (!id || !brands.some(brand => brand.id === id && brand.published)) return;
   setCategory('All');
   setQuery('');
   setOnlySaved(false);
   setRandomPick({ id });
 };
 useEffect(() => {
   if (!randomPick) return;
   const card = document.getElementById(`brand-card-${encodeURIComponent(randomPick.id)}`);
   if (!card) return;
   card.focus({ preventScroll: true });
   card.scrollIntoView({
     behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
     block: 'center',
   });
 }, [randomPick]);
 const hasSocialContacts = (settings.whatsappEnabled && isSafeSocialUrl(settings.whatsappUrl)) || (settings.telegramEnabled && isSafeSocialUrl(settings.telegramUrl)) || (settings.facebookEnabled && isSafeSocialUrl(settings.facebookUrl));
 const categories=[['All','All',LayoutGrid],['Update','Update',Layers],['New','New',Sparkles]] as const;
 return <div className="public-site" id="top">
  <AnnouncementTicker text={settings.announcement} />
  <header className="site-header">
   <div className="nav-shell">
    <a className="wordmark" href="/" aria-label={`${settings.name} home`}>
     <img className="site-logo-image" src={avatarImageUrl} alt="" />
     <span className="header-brand-name">{settings.name}</span>
     <span className="wordmark-point">®</span>
    </a>
    <MalaysiaClock label={clockLabels[lang]} />
    <div className="nav-actions">
     <div className="lang-switch" aria-label="Language">
      {(['EN','BM','中文'] as Lang[]).map(l => (
       <button key={l} aria-pressed={lang===l} className={lang===l?'selected':''} onClick={()=>setLang(l)}>{l}</button>
      ))}
     </div>
     <button className={`saved-nav ${onlySaved?'is-saved':''}`} aria-label={`${t.saved} (${saved.length})`} aria-pressed={onlySaved} onClick={showSaved}>
      <Bookmark size={15} /><span>{t.saved}</span><span className="saved-count">{saved.length}</span>
     </button>
    </div>
   </div>
  </header>
  <main>
   <section className={hasDefaultGift ? 'hero-stage has-gift-orbit' : 'hero-stage'}>
    <div className="hero section-shell">
     <div className="hero-copy has-hero-entrance" style={{ '--hero-line-count': settings.headline.split('\n').length } as React.CSSProperties}>
      <h1>{settings.headline.split('\n').map((line, index) => (
        <span key={index} className={index > 0 ? 'accent-line' : ''} style={{ '--hero-line-index': index } as React.CSSProperties}>{line}</span>
      ))}</h1>
      <p>{settings.description}</p>
      <div className="hero-actions">
       <button className="primary-button" onClick={() => { setOnlySaved(false); jump('collection'); }}>
        {t.explore}<ArrowUpRight size={19} />
       </button>
      </div>
     </div>
     <div className="hero-visual">
      <BrandScene
       coverImageUrl={hasDefaultGift ? defaultCoverImageUrl : settings.coverImageUrl}
       openingPlateUrl={hasDefaultGift ? defaultGiftOpeningPlateUrl : undefined}
      />
     </div>
    </div>
    {hasDefaultGift && <GiftOrbit />}
   </section>
   <RandomBrandPicker brands={brands} lang={lang} onPick={revealRandomPick} />
   {featured.length>0&&!onlySaved&&<section className="spotlight section-shell"><div className="section-heading"><div><div className="eyebrow muted-eyebrow"><span className="tiny-square"/>{t.featured}</div><h2>{t.editor}</h2></div><button className="text-button" onClick={()=>jump('collection')}>{t.all}<ArrowUpRight size={17}/></button></div><div className="spotlight-grid">{featured.map((b,i)=><article className={`spotlight-card spotlight-${i}${b.imageUrl?' has-brand-image':''}`} key={b.id} style={{'--brand-color':b.color} as React.CSSProperties}><button className="spotlight-open" onClick={()=>setActive(b)} aria-label={`${t.view} ${b.name}`}><BrandArtwork brand={b}/><div className="spotlight-overlay"><span className="spotlight-tag"><span/>{i===0?'EDITOR’S PICK':i===1?'A FRESH PERSPECTIVE':'ONE TO EXPLORE'}</span><div className="spotlight-text"><div><small>{effectiveBrandCategory(b, promotionNow)}</small><h3>{b.name}</h3><p>{b.tagline}</p></div><span className="round-link"><ArrowUpRight size={22}/></span></div></div></button><button className={`favorite-button ${saved.includes(b.id)?'is-saved':''}`} aria-label={saved.includes(b.id)?`Unsave ${b.name}`:`Save ${b.name}`} aria-pressed={saved.includes(b.id)} onClick={()=>toggleSaved(b.id)}><Heart size={17} fill={saved.includes(b.id)?'currentColor':'none'}/></button></article>)}</div></section>}
   <section className="collection section-shell" id="collection"><div className="section-heading collection-heading"><div><div className="eyebrow muted-eyebrow"><span className="tiny-square"/> {onlySaved?'YOUR PERSONAL EDIT':'EXPLORE THE DIRECTORY'}</div><h2>{onlySaved?t.favorite:t.browse}</h2><p>{onlySaved?t.noSaved:t.sub}</p></div><span className="collection-symbol">↗</span></div><div className="directory-tools"><div className="category-tabs" aria-label="Filter categories">{categories.map(([c,label,I])=><button key={c} className={category===c?'active':''} onClick={()=>setCategory(c)} aria-pressed={category===c}><I size={15}/>{label}{c==='All'&&<span>{brands.length}</span>}</button>)}</div><label className="search-input"><Search size={17}/><input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t.search} aria-label={t.search}/>{query&&<button aria-label="Clear search" onClick={()=>setQuery('')}><X size={15}/></button>}</label></div><div className="results-toolbar"><span>{String(filtered.length).padStart(2,'0')} <span>{t.result}</span>{onlySaved&&<button className="filter-pill" onClick={()=>setOnlySaved(false)}>{t.saved}<X size={12}/></button>}</span><label><SlidersHorizontal size={13}/><select aria-label="Sort brands" value={sort} onChange={e=>setSort(e.target.value)}><option value="featured">{t.sort}</option><option value="az">{t.az}</option></select><ChevronDown size={12}/></label></div><div className="brand-grid">{filtered.map(b=>{const I=brandIcons[b.icon]||Sparkles;return <article key={b.id} id={`brand-card-${encodeURIComponent(b.id)}`} tabIndex={-1} aria-labelledby={`brand-title-${encodeURIComponent(b.id)}`} className={`directory-card${randomPick?.id===b.id?' is-random-pick':''}`} style={{'--brand-color':b.color} as React.CSSProperties}><div className="card-image"><button className="art-open" onClick={()=>setActive(b)} aria-label={`${t.view} ${b.name}`}><BrandArtwork brand={b}/></button></div><div className="card-content"><div className="brand-card-tools"><span className="category-tag">{effectiveBrandCategory(b, promotionNow)}</span><button className={`favorite-button ${saved.includes(b.id)?'is-saved':''}`} aria-label={saved.includes(b.id)?`Unsave ${b.name}`:`Save ${b.name}`} aria-pressed={saved.includes(b.id)} onClick={()=>toggleSaved(b.id)}><Heart size={16} fill={saved.includes(b.id)?'currentColor':'none'}/></button></div><div className="card-brand"><span className="brand-mini"><I size={18}/></span><h3 id={`brand-title-${encodeURIComponent(b.id)}`}>{b.name}</h3>{b.featured&&<Sparkles className="featured-icon" size={14}/>}</div><p>{b.tagline}</p><button className="card-action" onClick={()=>setActive(b)}>{t.view}<ArrowUpRight size={16}/></button></div></article>;})}</div>{filtered.length===0&&<div className="empty-state"><Compass size={40}/><h3>{t.empty}</h3><p>{t.emptyText}</p><button className="primary-button" onClick={()=>{setCategory('All');setQuery('');setOnlySaved(false);}}>{t.clear}<ArrowRight size={16}/></button></div>}<div className="demo-note"><span className="live-dot"/><span>{t.demo}</span><span className="demo-divider">/</span>{t.demoText}</div></section>
   <SocialContacts settings={settings} lang={lang} />
   <AcceptedMethods lang={lang} />
   <section className="faq-section section-shell"><div><div className="eyebrow muted-eyebrow"><span className="tiny-square"/> {t.faqKicker}</div><h2>{t.faq}</h2><p>{t.intro}</p></div><div className="faq-list">{[[t.faq1,t.answer1],[t.faq2,t.answer2],[t.faq3,t.answer3]].map(([q,a],i)=><article key={i}><button onClick={()=>setFaq(faq===i?null:i)} aria-expanded={faq===i} aria-controls={`faq-${i}`}>{q}<span>{faq===i?'−':'+'}</span></button>{faq===i&&<p id={`faq-${i}`}>{a}</p>}</article>)}</div></section>
  </main><footer><div className="section-shell footer-main"><div><a className="wordmark" href="/"><img className="site-logo-image" src={avatarImageUrl} alt=""/>{settings.name}<span className="wordmark-point">®</span></a><p>{t.footer}</p></div><div className="footer-links"><button onClick={()=>jump('collection')}>{t.collection}</button>{hasSocialContacts&&<button onClick={()=>jump('contact')}>{t.contact}</button>}{!hasSocialContacts&&settings.contactUrl&&<a href={settings.contactUrl} target="_blank" rel="noopener noreferrer">{t.contact}<ArrowUpRight size={12}/></a>}</div><button className="back-top" aria-label={t.back} onClick={()=>jump('top')}><ArrowRight size={19}/></button></div><div className="section-shell footer-bottom"><span>© {new Date().getFullYear()} {settings.name}. A space for discovery.</span><span className="footer-demo">DEMO EDITION <span/></span><a href="/admin">{t.dashboard}<ArrowUpRight size={12}/></a></div></footer>
  {(active||info)&&<div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget){setActive(null);setInfo(false);}}}><section className={`detail-modal ${info?'info-modal':''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><button ref={closeRef} className="modal-close" aria-label="Close" onClick={()=>{setActive(null);setInfo(false);}}><X size={21}/></button>{active?<><BrandArtwork brand={active} large/><div className="detail-content"><span className="detail-kicker">{t.details} <span>/ {effectiveBrandCategory(active, promotionNow)}</span></span><h2 id="modal-title">{active.name}</h2><p className="detail-tagline">{active.tagline}</p><h3>{t.about}</h3><p className="detail-description">{active.description}</p><div className="detail-actions">{active.link?<a className="primary-button" href={active.link} target="_blank" rel="noopener noreferrer">{t.visit}<ExternalLink size={16}/></a>:<button className="primary-button" onClick={()=>setActive(null)}>{t.close}<ArrowRight size={16}/></button>}<button className={`detail-save ${saved.includes(active.id)?'is-saved':''}`} aria-pressed={saved.includes(active.id)} onClick={()=>toggleSaved(active.id)}><Heart size={18} fill={saved.includes(active.id)?'currentColor':'none'}/>{t.saved}{saved.includes(active.id)&&<Check size={15}/>}</button></div><span className="detail-demo">{t.demoText}</span></div></>:<div className="detail-content"><HelpCircle size={36}/><h2 id="modal-title">{t.contact}</h2><p className="detail-description">{t.contactText}</p><button className="primary-button" onClick={()=>setInfo(false)}>{t.close}<ArrowRight size={16}/></button></div>}</section></div>}
 </div>;
}
