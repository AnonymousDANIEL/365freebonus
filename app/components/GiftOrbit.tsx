'use client';

import { useEffect, useRef } from 'react';
import './gift-orbit.css';

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
type OrbitLayout = {
  width: number;
  height: number;
  center: Point;
  radiusX: number;
  radiusY: number;
  mouth: Point;
  joinAngle: number;
  launchBend: Point;
  radius: number;
  copy: Bounds | null;
};
type OpeningScene = {
  view: SVGSVGElement;
  lid: SVGGElement;
  lidShade: SVGPathElement;
  interior: SVGPathElement;
  bloom: SVGGraphicsElement;
  rays: SVGGraphicsElement | null;
  core: SVGGraphicsElement | null;
  wordmark: SVGGElement;
  digits: SVGGElement | null;
  subtitle: SVGGElement | null;
  plateUrl: string;
};

const OPENING_LAUNCH_TIME = 1.25;
const POSTER_REVEAL_START = 3.02;
const POSTER_REVEAL_END = 3.22;
const FULL_TURN = Math.PI * 2;
const LAUNCH_INTERVAL = 0.65;
const LIFTOFF = 0.76;
// Ten equally spaced slots keep the visible ring in coin / gem order.
const ORBIT_TIME = LAUNCH_INTERVAL * 10;
const END_FADE = 0.12;
const LIFETIME = LIFTOFF + ORBIT_TIME + END_FADE;
const ANGULAR_SPEED = FULL_TURN / ORBIT_TIME;
const GEMS = [
  ['#eee0ff', '#b890e7', '#7340a0', '#422462'],
  ['#dff9f3', '#89d0c9', '#428982', '#235655'],
  ['#ffe2eb', '#de91ac', '#a84970', '#6a274b'],
  ['#fff1d6', '#e7be7e', '#b07848', '#714638'],
] as const;

const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

function ease(value: number) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function getOpening(stage: Element): OpeningScene | null {
  const view = stage.querySelector<SVGSVGElement>('[data-gift-opening]');
  const lid = view?.querySelector<SVGGElement>('[data-gift-lid]');
  const lidShade = view?.querySelector<SVGPathElement>('[data-gift-lid-shade]');
  const interior = view?.querySelector<SVGPathElement>('[data-gift-interior]');
  const bloom = view?.querySelector<SVGGraphicsElement>('[data-gift-bloom]');
  const rays = view?.querySelector<SVGGraphicsElement>('[data-gift-rays]') ?? null;
  const core = view?.querySelector<SVGGraphicsElement>('[data-gift-core]') ?? null;
  const wordmark = view?.querySelector<SVGGElement>('[data-gift-wordmark]');
  const digits = view?.querySelector<SVGGElement>('[data-gift-digits]') ?? null;
  const subtitle = view?.querySelector<SVGGElement>('[data-gift-subtitle]') ?? null;
  const plateUrl = view?.querySelector('[data-gift-plate]')?.getAttribute('href');
  return view && lid && lidShade && interior && bloom && wordmark && plateUrl
    ? { view, lid, lidShade, interior, bloom, rays, core, wordmark, digits, subtitle, plateUrl }
    : null;
}

function showOpenPoster(scene: OpeningScene) {
  scene.view.parentElement?.style.setProperty('--gift-poster-opacity', '1');
  scene.view.style.opacity = '0';
  scene.view.style.visibility = 'hidden';
}

function paintOpening(scene: OpeningScene, elapsed: number) {
  const rise = ease((elapsed - 0.25) / 1.0);
  const tilt = Math.sin(Math.PI * rise);
  scene.lid.setAttribute('transform', `translate(${-19 * tilt} ${411 * (1 - rise)}) rotate(${-11 * tilt} 724 255)`);

  const light = ease((elapsed - 0.30) / 0.65);
  const lightSettle = ease((elapsed - 1.15) / 1.90);
  scene.interior.setAttribute('opacity', String(0.94 * (1 - light)));
  scene.lidShade.setAttribute('opacity', String(0.92 * (1 - light)));
  scene.bloom.setAttribute('opacity', String(light * (0.98 - 0.64 * lightSettle)));
  scene.rays?.setAttribute('opacity', String(light * (0.88 - 0.64 * lightSettle)));
  scene.core?.setAttribute('opacity', String(light * (0.96 - 0.41 * lightSettle)));

  if (scene.digits && scene.subtitle) {
    scene.wordmark.setAttribute('opacity', '1');
    scene.wordmark.removeAttribute('transform');
    const digits = ease((elapsed - 1.85) / 0.75);
    scene.digits.setAttribute('transform', `translate(0 ${360 * (1 - digits)}) translate(724 744) scale(${0.85 + 0.15 * digits}) translate(-724 -744)`);
    scene.digits.setAttribute('opacity', String(ease((elapsed - 1.85) / 0.23)));
    const subtitle = ease((elapsed - 2.42) / 0.60);
    scene.subtitle.setAttribute('transform', `translate(0 ${150 * (1 - subtitle)}) translate(724 744) scale(${0.90 + 0.10 * subtitle}) translate(-724 -744)`);
    scene.subtitle.setAttribute('opacity', String(ease((elapsed - 2.42) / 0.21)));
  } else {
    const emerge = ease((elapsed - 1.85) / 1.17);
    scene.wordmark.setAttribute('transform', `translate(0 ${310 * (1 - emerge)})`);
    scene.wordmark.setAttribute('opacity', String(ease((elapsed - 1.85) / 0.31)));
  }

  if (elapsed >= POSTER_REVEAL_START) {
    const reveal = ease((elapsed - POSTER_REVEAL_START) / (POSTER_REVEAL_END - POSTER_REVEAL_START));
    scene.view.parentElement?.style.setProperty('--gift-poster-opacity', String(reveal));
    scene.view.style.opacity = String(1 - reveal);
  }
}

function measureLayout(canvas: HTMLCanvasElement, artwork: HTMLImageElement, copy: HTMLElement | null): OrbitLayout | null {
  const viewport = canvas.getBoundingClientRect();
  const image = artwork.getBoundingClientRect();
  if (viewport.width < 100 || viewport.height < 100 || !artwork.naturalWidth || !image.width || !image.height) return null;

  // The image is object-fit: contain. Use the visible artwork rather than its padded element.
  const fit = Math.min(image.width / artwork.naturalWidth, image.height / artwork.naturalHeight);
  const artWidth = artwork.naturalWidth * fit;
  const artHeight = artwork.naturalHeight * fit;
  const artLeft = image.left - viewport.left + (image.width - artWidth) / 2;
  const artTop = image.top - viewport.top + (image.height - artHeight) / 2;
  const copyRect = copy?.getBoundingClientRect();
  const stacked = viewport.width <= 640 || !!(copyRect && image.top >= copyRect.bottom - 8);
  const radius = stacked ? clamp(artWidth * 0.041, 11, 16) : clamp(viewport.width * 0.014, 16, 24);
  const inset = Math.ceil(radius * 1.35 + 6);
  const center = {
    x: stacked ? artLeft + artWidth / 2 : viewport.width / 2,
    y: stacked ? artTop + artHeight / 2 : viewport.height * 0.50,
  };
  const radiusX = Math.min(center.x - inset, viewport.width - center.x - inset, stacked ? artWidth * 0.53 : Infinity);
  const radiusY = Math.min(center.y - inset, viewport.height - center.y - inset, stacked ? artHeight * 0.43 : viewport.height * 0.435);
  if (radiusX < 24 || radiusY < 24) return null;

  // This point is the illuminated interior, just behind the gold front rim.
  const mouth = { x: artLeft + artWidth * 0.5, y: artTop + artHeight * 0.713 };
  return {
    width: viewport.width,
    height: viewport.height,
    center,
    radiusX,
    radiusY,
    mouth,
    joinAngle: clamp(Math.asin(clamp((mouth.y - center.y) / radiusY, -0.75, 0.75)) - 0.11, 0.17, 0.64),
    launchBend: { x: mouth.x + artWidth * 0.09, y: mouth.y - artHeight * 0.23 },
    radius,
    copy: copyRect && !stacked ? {
      left: copyRect.left - viewport.left - 12,
      top: copyRect.top - viewport.top - 12,
      right: copyRect.right - viewport.left + 12,
      bottom: copyRect.bottom - viewport.top + 12,
    } : null,
  };
}

function position(layout: OrbitLayout, age: number): Point {
  const angle = layout.joinAngle - ANGULAR_SPEED * clamp(age - LIFTOFF, 0, ORBIT_TIME);
  const end = {
    x: layout.center.x + layout.radiusX * Math.cos(angle),
    y: layout.center.y + layout.radiusY * Math.sin(angle),
  };
  if (age >= LIFTOFF) return end;

  // A cubic lift from the gift mouth meets the orbit with the same tangent and speed.
  const tangent = {
    x: layout.radiusX * Math.sin(angle) * ANGULAR_SPEED,
    y: -layout.radiusY * Math.cos(angle) * ANGULAR_SPEED,
  };
  const entry = { x: end.x - tangent.x * LIFTOFF / 3, y: end.y - tangent.y * LIFTOFF / 3 };
  const t = clamp(age / LIFTOFF, 0, 1);
  const u = 1 - t;
  return {
    x: u ** 3 * layout.mouth.x + 3 * u * u * t * layout.launchBend.x + 3 * u * t * t * entry.x + t ** 3 * end.x,
    y: u ** 3 * layout.mouth.y + 3 * u * u * t * layout.launchBend.y + 3 * u * t * t * entry.y + t ** 3 * end.y,
  };
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, FULL_TURN);
}

function polygon(ctx: CanvasRenderingContext2D, points: ReadonlyArray<readonly [number, number]>) {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(...points[i]);
  ctx.closePath();
}

function drawCoin(ctx: CanvasRenderingContext2D, r: number, turn: number) {
  const width = r * (0.14 + 0.86 * Math.abs(Math.cos(turn)));
  const edge = Math.sin(turn) * r * 0.22;
  const edgeColor = ctx.createLinearGradient(0, -r, 0, r);
  edgeColor.addColorStop(0, '#ffe6aa');
  edgeColor.addColorStop(0.46, '#ad762d');
  edgeColor.addColorStop(1, '#62391a');
  ctx.fillStyle = edgeColor;
  ellipse(ctx, edge, 0, width, r);
  ctx.fill();

  const face = ctx.createLinearGradient(-width, -r, width, r);
  face.addColorStop(0, '#fff4cf');
  face.addColorStop(0.31, '#e3b565');
  face.addColorStop(0.53, '#9a632c');
  face.addColorStop(0.75, '#f3ca79');
  face.addColorStop(1, '#f9e2a6');
  ellipse(ctx, 0, 0, width, r);
  ctx.fillStyle = face;
  ctx.fill();
  ctx.lineWidth = Math.max(0.7, r * 0.054);
  ctx.strokeStyle = '#f8dda4';
  ctx.stroke();
  if (width > r * 0.24) {
    ellipse(ctx, 0, 0, width * 0.78, r * 0.78);
    ctx.strokeStyle = '#fff1b6b5';
    ctx.stroke();
    polygon(ctx, [[0, -r * 0.49], [width * 0.14, -r * 0.15], [width * 0.48, 0], [width * 0.14, r * 0.15], [0, r * 0.49], [-width * 0.14, r * 0.15], [-width * 0.48, 0], [-width * 0.14, -r * 0.15]]);
    ctx.fillStyle = '#ffe5ac';
    ctx.fill();
  }
}

function drawGem(ctx: CanvasRenderingContext2D, r: number, turn: number, palette: typeof GEMS[number]) {
  const width = r * (0.59 + 0.41 * Math.abs(Math.cos(turn)));
  const table = -r * 0.64;
  const shoulder = -r * 0.12;
  const left = [-width, shoulder] as const;
  const right = [width, shoulder] as const;
  const tip = [0, r] as const;
  const ridge = [width * Math.sin(turn) * 0.22, shoulder] as const;
  const crownLeft = [-width * 0.55, table] as const;
  const crownRight = [width * 0.55, table] as const;

  polygon(ctx, [crownLeft, crownRight, right, tip, left]);
  ctx.fillStyle = palette[2];
  ctx.fill();
  polygon(ctx, [left, ridge, tip]);
  ctx.fillStyle = palette[1];
  ctx.fill();
  polygon(ctx, [ridge, right, tip]);
  ctx.fillStyle = palette[3];
  ctx.fill();
  polygon(ctx, [crownLeft, crownRight, ridge]);
  ctx.fillStyle = palette[0];
  ctx.fill();
  polygon(ctx, [crownLeft, crownRight, right, tip, left]);
  ctx.strokeStyle = palette[1];
  ctx.lineWidth = Math.max(0.7, r * 0.052);
  ctx.stroke();
}

function paint(ctx: CanvasRenderingContext2D, layout: OrbitLayout, elapsed: number) {
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.save();
  if (layout.copy) {
    // Passing behind the copy keeps the full orbit clear of the headline and actions.
    ctx.beginPath();
    ctx.rect(0, 0, layout.width, layout.height);
    ctx.rect(layout.copy.left, layout.copy.top, layout.copy.right - layout.copy.left, layout.copy.bottom - layout.copy.top);
    ctx.clip('evenodd');
  }
  const latest = Math.floor(elapsed / LAUNCH_INTERVAL);
  const oldest = Math.max(0, Math.floor((elapsed - LIFETIME) / LAUNCH_INTERVAL) + 1);
  const phase = elapsed - latest * LAUNCH_INTERVAL;
  if (phase < 0.33) {
    const glowRadius = layout.radius * 1.48;
    const { x, y } = layout.mouth;
    const light = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
    const pulse = Math.sin(phase / 0.33 * Math.PI);
    light.addColorStop(0, `rgba(255, 226, 164, ${pulse * 0.42})`);
    light.addColorStop(1, 'rgba(255, 203, 113, 0)');
    ctx.fillStyle = light;
    ellipse(ctx, x, y, glowRadius, glowRadius);
    ctx.fill();
  }

  for (let index = oldest; index <= latest; index += 1) {
    const age = elapsed - index * LAUNCH_INTERVAL;
    const coin = index % 2 === 0;
    const variation = index * 2.3999632;
    const point = position(layout, age);
    const depth = clamp((point.y - layout.center.y) / layout.radiusY, -1, 1);
    const radius = layout.radius * (0.88 + depth * 0.18) * (0.28 + 0.72 * ease(age / (LIFTOFF * 0.82)));
    // A particle finishes its complete turn before its brief dissolve at the join.
    const fade = ease(age / 0.13) * (1 - ease((age - (LIFTOFF + ORBIT_TIME)) / END_FADE));
    const alpha = fade * (0.84 + depth * 0.14);
    const gem = GEMS[Math.floor(index / 2) % GEMS.length];

    ctx.save();
    const trailSpan = Math.min(age, coin ? 0.32 : 0.22);
    if (trailSpan > 0.03) {
      const tail = position(layout, age - trailSpan);
      const trail = ctx.createLinearGradient(tail.x, tail.y, point.x, point.y);
      trail.addColorStop(0, coin ? '#e3a95500' : `${gem[1]}00`);
      trail.addColorStop(1, coin ? '#f8ce8799' : `${gem[1]}66`);
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      for (let sample = 1; sample <= 12; sample += 1) {
        const segment = position(layout, age - trailSpan + trailSpan * sample / 12);
        ctx.lineTo(segment.x, segment.y);
      }
      ctx.globalAlpha = alpha * (coin ? 0.68 : 0.40);
      ctx.strokeStyle = trail;
      ctx.lineWidth = coin ? 1.15 : 0.85;
      ctx.lineCap = 'round';
      ctx.shadowColor = coin ? '#f4bc70' : gem[1];
      ctx.shadowBlur = coin ? 3 : 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = alpha;
    ctx.translate(point.x, point.y);
    ctx.rotate(Math.sin(age * 1.8 + variation) * (coin ? 0.43 : 0.30));
    const turn = age * (coin ? 4.4 : 2.8) + variation;
    if (coin) drawCoin(ctx, radius, turn);
    else drawGem(ctx, radius, turn, gem);
    ctx.restore();
  }
  ctx.restore();
}

/** A decorative layer measured against the full hero, independent of its content column. */
export default function GiftOrbit() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = canvas?.closest('.hero-stage');
    const artwork = stage?.querySelector<HTMLImageElement>('.hero-visual .brand-scene-image img');
    if (!canvas || !stage || !artwork) return;
    const opening = getOpening(stage);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (opening) showOpenPoster(opening);
      return;
    }

    const copy = stage.querySelector<HTMLElement>('.hero-copy');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let layout: OrbitLayout | null = null;
    let inView = true;
    let elapsed = 0;
    let openingReady = !opening;
    let openingActive = !!opening;
    let launchTime = opening ? OPENING_LAUNCH_TIME : 0;
    let previousTime: number | null = null;
    let frame = 0;

    const canAnimate = () => layout && openingReady && inView && !document.hidden && !reducedMotion.matches;

    const tick = (now: number) => {
      frame = 0;
      if (!layout || !canAnimate()) return;
      if (previousTime !== null) elapsed += Math.min(0.1, (now - previousTime) / 1000);
      previousTime = now;
      if (opening && openingActive) {
        if (elapsed >= POSTER_REVEAL_END) {
          showOpenPoster(opening);
          openingActive = false;
        } else {
          paintOpening(opening, elapsed);
        }
      }
      // The first coin precedes the rising digits. This clock continues through the poster handoff.
      if (elapsed >= launchTime) paint(ctx, layout, elapsed - launchTime);
      frame = window.requestAnimationFrame(tick);
    };

    const sync = () => {
      if (reducedMotion.matches) {
        if (opening && openingActive) {
          showOpenPoster(opening);
          launchTime = Math.min(launchTime, elapsed);
        }
        openingActive = false;
      }
      if (canAnimate()) {
        if (!frame) frame = window.requestAnimationFrame(tick);
      } else {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
        previousTime = null;
        if (reducedMotion.matches && layout) ctx.clearRect(0, 0, layout.width, layout.height);
      }
    };

    const measure = () => {
      layout = measureLayout(canvas, artwork, copy);
      if (layout) {
        // Cap bitmap pixels on large monitors while retaining sharp sprites on mobile.
        const ratio = Math.min(window.devicePixelRatio || 1, 1.7, Math.sqrt(2_600_000 / (layout.width * layout.height)));
        canvas.width = Math.ceil(layout.width * ratio);
        canvas.height = Math.ceil(layout.height * ratio);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      } else {
        canvas.width = 1;
        canvas.height = 1;
      }
      sync();
    };

    const skipOpening = () => {
      if (opening) showOpenPoster(opening);
      openingActive = false;
      openingReady = true;
      launchTime = elapsed;
      sync();
    };

    // Wait for the visible closed frame and original art before advancing the one clock.
    // The SVG uses the same cached plate URL, so this does not duplicate the download.
    const plate = opening ? new Image() : null;
    if (plate && opening) {
      plate.onload = () => { openingReady = true; sync(); };
      plate.onerror = skipOpening;
      plate.src = opening.plateUrl;
    }

    const resize = new ResizeObserver(measure);
    resize.observe(stage);
    resize.observe(artwork);
    if (copy) resize.observe(copy);
    const visibility = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    visibility.observe(stage);
    artwork.addEventListener('load', measure);
    artwork.addEventListener('error', skipOpening);
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    if (artwork.complete && !artwork.naturalWidth) skipOpening();
    measure();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
      artwork.removeEventListener('load', measure);
      artwork.removeEventListener('error', skipOpening);
      if (plate) { plate.onload = null; plate.onerror = null; }
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
    };
  }, []);

  return <canvas ref={canvasRef} className="gift-orbit" aria-hidden="true" />;
}
