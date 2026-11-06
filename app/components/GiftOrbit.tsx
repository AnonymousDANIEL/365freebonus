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

const FULL_TURN = Math.PI * 2;
const LAUNCH_INTERVAL = 0.65;
const LIFTOFF = 0.68;
const ORBIT_TIME = 5.70;
const END_FADE = 0.26;
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
  const radiusY = Math.min(center.y - inset, viewport.height - center.y - inset, stacked ? artHeight * 0.43 : viewport.height * 0.36);
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
    launchBend: { x: mouth.x + artWidth * 0.19, y: mouth.y - artHeight * 0.06 },
    radius,
    copy: copyRect && !stacked ? {
      left: copyRect.left - viewport.left,
      top: copyRect.top - viewport.top,
      right: copyRect.right - viewport.left,
      bottom: copyRect.bottom - viewport.top,
    } : null,
  };
}

function position(layout: OrbitLayout, age: number, offset: number): Point {
  const angle = layout.joinAngle + offset - ANGULAR_SPEED * Math.max(0, age - LIFTOFF);
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
  const latest = Math.floor(elapsed / LAUNCH_INTERVAL);
  const oldest = Math.max(-6, Math.floor((elapsed - LIFETIME) / LAUNCH_INTERVAL) + 1);
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
    const offset = Math.sin(variation) * 0.042;
    const point = position(layout, age, offset);
    const depth = clamp((point.y - layout.center.y) / layout.radiusY, -1, 1);
    const radius = layout.radius * (0.88 + depth * 0.18) * (0.28 + 0.72 * ease(age / (LIFTOFF * 0.82)));
    const fade = ease(age / 0.16) * (1 - ease((age - (LIFTOFF + ORBIT_TIME - 0.14)) / (END_FADE + 0.14)));
    const underCopy = layout.copy && point.x > layout.copy.left && point.x < layout.copy.right && point.y > layout.copy.top && point.y < layout.copy.bottom;
    const alpha = fade * (underCopy ? 0.56 : 0.84 + depth * 0.14);
    const gem = GEMS[((Math.floor(index / 2) % GEMS.length) + GEMS.length) % GEMS.length];

    ctx.save();
    ctx.fillStyle = coin ? '#f0ce85' : gem[0];
    for (let i = 4; i > 0; i -= 1) {
      const trailingAge = age - i * 0.031;
      if (trailingAge <= 0) continue;
      const trailing = position(layout, trailingAge, offset);
      const dot = radius * (0.22 - i * 0.031);
      ctx.globalAlpha = alpha * (0.30 - i * 0.052);
      ellipse(ctx, trailing.x, trailing.y, dot, dot);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.translate(point.x, point.y);
    ctx.rotate(Math.sin(age * 1.8 + variation) * (coin ? 0.43 : 0.30));
    const turn = age * (coin ? 4.4 : 2.8) + variation;
    if (coin) drawCoin(ctx, radius, turn);
    else drawGem(ctx, radius, turn, gem);
    ctx.restore();
  }
}

/** A decorative layer measured against the full hero, independent of its content column. */
export default function GiftOrbit() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = canvas?.closest('.hero-stage');
    const artwork = stage?.querySelector<HTMLImageElement>('.hero-visual .brand-scene-image img');
    if (!canvas || !stage || !artwork) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const copy = stage.querySelector<HTMLElement>('.hero-copy');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let layout: OrbitLayout | null = null;
    let inView = true;
    let elapsed = 0;
    let previousTime: number | null = null;
    let frame = 0;

    const canAnimate = () => layout && inView && !document.hidden && !reducedMotion.matches;

    const tick = (now: number) => {
      frame = 0;
      if (!layout || !canAnimate()) return;
      if (previousTime !== null) elapsed += Math.min(0.1, (now - previousTime) / 1000);
      previousTime = now;
      paint(ctx, layout, elapsed);
      frame = window.requestAnimationFrame(tick);
    };

    const sync = () => {
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
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    measure();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
      artwork.removeEventListener('load', measure);
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
    };
  }, []);

  return <canvas ref={canvasRef} className="gift-orbit" aria-hidden="true" />;
}
