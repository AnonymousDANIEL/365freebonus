'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Gamepad2, Moon, Orbit, Pause, Play, Shuffle, Sparkles, Sun, Triangle } from 'lucide-react';
import type { Brand } from '../lib/directory';
import './random-brand-picker.css';

type Lang = 'EN' | 'BM' | '中文';
type Props = { brands: Brand[]; lang: Lang; onPick: (id: string) => void };
type Reel = { items: Brand[]; start: number; end: number; run: number };
const DURATION = 1850;
const CENTER = 4;
const IDLE_SPEED = .45; // Brand widths per second; independent of display refresh rate.
const icons = { sparkles: Sparkles, orbit: Orbit, sun: Sun, gamepad: Gamepad2, moon: Moon, triangle: Triangle };
const words = {
  EN: { kicker: 'LET CURIOSITY CHOOSE', title: 'Meet your next favourite.', hint: 'A random pick from All brands', spin: 'Spin random', spinning: 'Spinning…', idle: 'Where will curiosity take you?', choosing: 'Finding a little inspiration…', selected: 'Selected', empty: 'No published brands to pick yet.' },
  BM: { kicker: 'BIAR RASA INGIN TAHU MEMILIH', title: 'Temui kegemaran baharu.', hint: 'Pilihan rawak daripada semua jenama', spin: 'Spin rawak', spinning: 'Memilih…', idle: 'Ke mana rasa ingin tahu membawa anda?', choosing: 'Mencari sedikit inspirasi…', selected: 'Dipilih', empty: 'Belum ada jenama diterbitkan untuk dipilih.' },
  '中文': { kicker: '让好奇心替你选择', title: '随机发现，下一个喜爱。', hint: '从 All 全部品牌中随机抽选', spin: 'SPIN 随机抽选', spinning: '抽选中…', idle: '轻轻一转，发现新的品牌。', choosing: '正在寻找下一份灵感…', selected: '已选中', empty: '暂无已发布品牌可供抽选。' },
};

function idleReel(pool: Brand[], selectedId?: string): Reel {
  if (!pool.length) return { items: [], start: CENTER, end: CENTER, run: 0 };
  const selected = Math.max(0, pool.findIndex(brand => brand.id === selectedId));
  // One complete cycle plus both viewport buffers makes wrapping invisible.
  return { items: Array.from({ length: pool.length + 9 }, (_, index) => pool[((selected + index - CENTER) % pool.length + pool.length) % pool.length]), start: CENTER, end: CENTER, run: 0 };
}

// Rejection sampling gives every published brand the same chance, including the previous pick.
function randomIndex(length: number): number {
  if (!globalThis.crypto?.getRandomValues) return Math.floor(Math.random() * length);
  const value = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / length) * length;
  do { globalThis.crypto.getRandomValues(value); } while (value[0] >= limit);
  return value[0] % length;
}

export default function RandomBrandPicker({ brands, lang, onPick }: Props) {
  const pool = useMemo(() => Array.from(new Map(brands.filter(brand => brand.published && brand.id).map(brand => [brand.id, brand])).values()), [brands]);
  const poolKey = useMemo(() => JSON.stringify(pool.map(brand => [brand.id, brand.name, brand.imageUrl, brand.icon, brand.color])), [pool]);
  const [reel, setReel] = useState<Reel>(() => idleReel(pool));
  const [spinning, setSpinning] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const idlePosition = useRef(CENTER);
  const running = useRef(false);
  const runNumber = useRef(0);
  const pickNumber = useRef(0);
  const pending = useRef<{ id: string; key: string; run: number } | null>(null);
  const previousPoolKey = useRef(poolKey);
  const current = useRef({ pool, poolKey, lang, onPick });
  current.current = { pool, poolKey, lang, onPick };
  const t = words[lang];
  const selected = pool.find(brand => brand.id === selectedId);

  useEffect(() => {
    if (previousPoolKey.current === poolKey) return;
    previousPoolKey.current = poolKey;
    runNumber.current += 1;
    pending.current = null;
    running.current = false;
    setSpinning(false);
    setSelectedId(undefined);
    setAnnouncement('');
    setReel(idleReel(current.current.pool));
  }, [poolKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || !reel.items.length) return;
    let frame = 0;
    let progress = 0;
    let position = reel.start;
    let lastFrame = 0;
    let stopped = false;
    let itemWidth = 0;
    let viewportWidth = 0;
    const place = () => {
      track.style.transform = `translate3d(${viewportWidth / 2 - (position + .5) * itemWidth}px,0,0)`;
    };
    const measure = () => {
      itemWidth = track.firstElementChild?.getBoundingClientRect().width || 0;
      viewportWidth = viewport.clientWidth;
      place();
    };
    const finish = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      const pick = pending.current;
      if (!pick || pick.run !== reel.run || pick.key !== current.current.poolKey) return;
      const winner = current.current.pool.find(brand => brand.id === pick.id);
      if (!winner) return;
      pending.current = null;
      running.current = false;
      setSpinning(false);
      setSelectedId(winner.id);
      setAnnouncement(`${words[current.current.lang].selected} ${++pickNumber.current}: ${winner.name}`);
      setReel(idleReel(current.current.pool, winner.id));
      current.current.onPick(winner.id);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    if (track.firstElementChild) observer?.observe(track.firstElementChild);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const idleTick = (now: number) => {
      if (stopped || motion.matches || document.hidden || !current.current.pool.length) return;
      if (lastFrame && !pausedRef.current) position += Math.min((now - lastFrame) / 1000, .1) * IDLE_SPEED;
      lastFrame = now;
      position = CENTER + (position - CENTER) % current.current.pool.length;
      idlePosition.current = position;
      place();
      frame = requestAnimationFrame(idleTick);
    };
    const resumeIdle = () => {
      if (reel.run || stopped) return;
      cancelAnimationFrame(frame);
      lastFrame = 0;
      if (!motion.matches && !document.hidden) frame = requestAnimationFrame(idleTick);
    };
    const onMotionChange = () => {
      if (motion.matches && reel.run) finish();
      else resumeIdle();
    };
    motion.addEventListener('change', onMotionChange);
    document.addEventListener('visibilitychange', resumeIdle);
    if (!reel.run) {
      idlePosition.current = position;
      resumeIdle();
    }
    if (reel.run) {
      if (motion.matches) finish();
      else {
        const started = performance.now();
        const tick = (now: number) => {
          if (stopped) return;
          const time = Math.min(1, (now - started) / DURATION);
          progress = 1 - (1 - time) ** 3;
          position = reel.start + (reel.end - reel.start) * progress;
          place();
          if (time < 1) frame = requestAnimationFrame(tick);
          else finish();
        };
        frame = requestAnimationFrame(tick);
      }
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      motion.removeEventListener('change', onMotionChange);
      document.removeEventListener('visibilitychange', resumeIdle);
    };
  }, [reel]);

  const spin = () => {
    if (running.current || !pool.length) return;
    const winner = pool[randomIndex(pool.length)];
    setAnnouncement('');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSelectedId(winner.id);
      setReel(idleReel(pool, winner.id));
      setAnnouncement(`${t.selected} ${++pickNumber.current}: ${winner.name}`);
      onPick(winner.id);
      return;
    }
    running.current = true;
    setSpinning(true);
    const run = ++runNumber.current;
    pending.current = { id: winner.id, key: poolKey, run };
    const base = idleReel(pool, selectedId);
    const start = idlePosition.current;
    const end = Math.ceil(start) + 24;
    const items = Array.from({ length: end + 5 }, (_, index) => base.items[index % pool.length]);
    items[end] = winner;
    setReel({ items, start, end, run });
  };

  return <section className={`random-brand-picker${spinning ? ' is-spinning' : ''}`} aria-label={t.title}>
    <div className="section-shell random-picker-shell">
      <div className="random-picker-intro">
        <span className="random-picker-kicker"><Sparkles size={12} aria-hidden="true" />{t.kicker}</span>
        <h2>{t.title}</h2>
        <p>{t.hint}</p>
      </div>
      <div className="random-picker-main">
        <div className="random-picker-reel" ref={viewportRef} aria-hidden="true">
          <span className="random-picker-marker" />
          <div className="random-picker-track" ref={trackRef}>
            {reel.items.map((brand, index) => {
              const Icon = icons[brand.icon as keyof typeof icons] || Sparkles;
              return <div className="random-picker-item" key={`${reel.run}-${index}`}>
                <span className="random-picker-brand-icon">{brand.imageUrl ? <img src={brand.imageUrl} alt="" loading="lazy" draggable={false} /> : <Icon size={21} strokeWidth={1.4} />}</span>
                <strong title={brand.name}>{brand.name}</strong>
              </div>;
            })}
          </div>
          {!pool.length && <span className="random-picker-empty">—</span>}
        </div>
        <p className="random-picker-caption">{!pool.length ? t.empty : spinning ? t.choosing : selected ? `${t.selected}: ${selected.name}` : t.idle}</p>
      </div>
      <div className="random-picker-controls">
        <button type="button" className="random-picker-button" onClick={spin} disabled={spinning || !pool.length}>
          <Shuffle size={17} aria-hidden="true" /><span>{spinning ? t.spinning : t.spin}</span>
        </button>
        {!!pool.length && <button type="button" className="random-picker-motion" disabled={spinning} aria-pressed={paused}
          aria-label={lang === '中文' ? (paused ? '继续滚动品牌' : '暂停滚动品牌') : lang === 'BM' ? (paused ? 'Sambung pergerakan jenama' : 'Jeda pergerakan jenama') : (paused ? 'Resume brand animation' : 'Pause brand animation')}
          onClick={() => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); }}>
          {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
        </button>}
      </div>
    </div>
    <span className="random-picker-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </section>;
}
