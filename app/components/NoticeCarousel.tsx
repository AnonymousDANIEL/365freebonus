'use client';

import { Bell, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { isSafeSocialUrl } from '../lib/directory';
import { isSafeImageUrl } from '../lib/image-url';
import type { PopupNotice } from '../lib/popup-notices';
import './notice-carousel.css';

const ROTATION_DELAY = 3000;
const labels = {
  en: { heading: 'Announcements', list: 'Choose an announcement', close: 'Close announcements', open: 'Open announcement' },
  ms: { heading: 'Pengumuman', list: 'Pilih pengumuman', close: 'Tutup pengumuman', open: 'Buka pengumuman' },
  zh: { heading: '最新公告', list: '选择公告', close: '关闭公告', open: '打开公告' },
};

export default function NoticeCarousel({ notices }: { notices: PopupNotice[] }) {
  const entries = useMemo(() => notices.filter(notice =>
    notice.enabled && notice.title.trim() && notice.imageUrl && isSafeImageUrl(notice.imageUrl)
  ), [notices]);
  const hasNotices = entries.length > 0;
  const [language, setLanguage] = useState<keyof typeof labels>('en');
  const [open, setOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [visible, setVisible] = useState(true);
  const [selected, setSelected] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const prefix = useId();
  const text = labels[language];
  const activeIndex = Math.min(selected, entries.length - 1);
  const active = entries[activeIndex];

  useEffect(() => {
    if (!hasNotices) return;
    if (window.location.hash.startsWith('#brand-card-')) {
      const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      if (navigation?.type !== 'reload') return;
    }

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => setReducedMotion(motion.matches);
    const syncVisibility = () => setVisible(!document.hidden);
    const syncLanguage = () => {
      const lang = document.documentElement.lang.toLowerCase();
      setLanguage(lang.startsWith('zh') ? 'zh' : lang.startsWith('ms') ? 'ms' : 'en');
    };
    syncMotion();
    syncVisibility();
    syncLanguage();
    const languageObserver = new MutationObserver(syncLanguage);
    languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    motion.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', syncVisibility);
    setOpen(true);
    return () => {
      motion.removeEventListener('change', syncMotion);
      document.removeEventListener('visibilitychange', syncVisibility);
      languageObserver.disconnect();
    };
  }, [hasNotices]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !hasNotices || !dialog || typeof dialog.showModal !== 'function') return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open, hasNotices]);

  useEffect(() => {
    if (!open || !visible || reducedMotion || keyboardFocus || entries.length < 2) return;
    const timeout = window.setTimeout(() => setSelected((activeIndex + 1) % entries.length), ROTATION_DELAY);
    return () => window.clearTimeout(timeout);
  }, [activeIndex, entries.length, keyboardFocus, open, reducedMotion, visible]);

  useEffect(() => {
    if (!open || !visible || entries.length < 2) return;
    const next = new Image();
    next.fetchPriority = 'low';
    next.referrerPolicy = 'no-referrer';
    next.src = entries[(activeIndex + 1) % entries.length].imageUrl;
  }, [activeIndex, entries, open, visible]);

  useEffect(() => {
    const list = listRef.current;
    const tab = tabRefs.current[activeIndex];
    if (!open || !list || !tab) return;
    if (tab.offsetTop < list.scrollTop) list.scrollTop = tab.offsetTop;
    const bottom = tab.offsetTop + tab.offsetHeight;
    if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [activeIndex, open]);

  function dismiss() {
    setOpen(false);
  }

  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight': next = (activeIndex + 1) % entries.length; break;
      case 'ArrowUp':
      case 'ArrowLeft': next = (activeIndex + entries.length - 1) % entries.length; break;
      case 'Home': next = 0; break;
      case 'End': next = entries.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setKeyboardFocus(true);
    setSelected(next);
    tabRefs.current[next]?.focus({ preventScroll: true });
  }

  if (!active) return null;
  const activeLink = isSafeSocialUrl(active.link) ? active.link : undefined;

  return <dialog
    ref={dialogRef}
    className="notice-carousel"
    aria-labelledby={`${prefix}-heading`}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => { if (event.target === event.currentTarget) dismiss(); }}
  >
    <div className="notice-carousel-shell">
      <header className="notice-carousel-header">
        <div>
          <span className="notice-carousel-kicker"><Bell size={13} aria-hidden="true" />365 Free Bonus</span>
          <h2 id={`${prefix}-heading`}>{text.heading}</h2>
        </div>
        <div className="notice-carousel-controls">
          <button type="button" className="notice-carousel-close" ref={closeRef} onClick={dismiss} aria-label={text.close}><X size={20} aria-hidden="true" /></button>
        </div>
      </header>
      <div className="notice-carousel-body">
        <div
          className="notice-carousel-tabs"
          ref={listRef}
          role="tablist"
          aria-orientation="vertical"
          aria-label={text.list}
          onKeyDown={selectWithKeyboard}
          onFocus={event => setKeyboardFocus(event.target.matches(':focus-visible'))}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false); }}
        >
          {entries.map((notice, index) => <button
            type="button"
            role="tab"
            key={notice.id}
            id={`${prefix}-tab-${notice.id}`}
            ref={node => { tabRefs.current[index] = node; }}
            aria-controls={`${prefix}-panel-${notice.id}`}
            aria-selected={index === activeIndex}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={event => { setKeyboardFocus(event.detail === 0); setSelected(index); }}
          ><span aria-hidden="true" />{notice.title}</button>)}
        </div>
        <div className="notice-carousel-panels" onFocus={event => setKeyboardFocus(event.target.matches(':focus-visible'))} onBlur={() => setKeyboardFocus(false)}>
          {entries.map(notice => <div
            key={notice.id}
            role="tabpanel"
            id={`${prefix}-panel-${notice.id}`}
            aria-labelledby={`${prefix}-tab-${notice.id}`}
            hidden={notice.id !== active.id}
          >
            {notice.id === active.id && <>
              {activeLink ? <a className="notice-carousel-media" href={activeLink} onClick={dismiss} aria-label={`${text.open}: ${notice.title}`}>
                {open && <img src={notice.imageUrl} alt="" referrerPolicy="no-referrer" />}
              </a> : <div className="notice-carousel-media">{open && <img src={notice.imageUrl} alt={notice.title} referrerPolicy="no-referrer" />}</div>}
            </>}
          </div>)}
        </div>
      </div>
    </div>
  </dialog>;
}
