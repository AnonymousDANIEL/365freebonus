'use client';

import { useEffect, useRef, useState } from 'react';
import './announcement-ticker.css';

const PIXELS_PER_SECOND = 105;
const BETWEEN_NOTICES_MS = 1000;

export default function AnnouncementTicker({ text }: { text: string }) {
  const lines = text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
  const [step, setStep] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const currentLine = lines[step % lines.length];

  useEffect(() => {
    const viewport = viewportRef.current;
    const line = lineRef.current;
    if (!viewport || !line || typeof line.animate !== 'function') return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;

    const play = () => {
      animation?.cancel();
      if (reducedMotion.matches) {
        delete viewport.dataset.scrolling;
        return;
      }

      viewport.dataset.scrolling = '';
      const start = viewport.clientWidth + 2;
      const duration = (start + line.offsetWidth + 2) * 1000 / PIXELS_PER_SECOND;
      animation = line.animate([
        { transform: `translateX(${start}px)`, visibility: 'visible' },
        { transform: 'translateX(calc(-100% - 2px))', visibility: 'visible' },
      ], { duration, delay: step === 0 ? 0 : BETWEEN_NOTICES_MS, fill: 'forwards' });
      animation.onfinish = () => setStep(previous => previous + 1);
    };

    play();
    reducedMotion.addEventListener('change', play);
    return () => {
      animation?.cancel();
      reducedMotion.removeEventListener('change', play);
    };
  }, [currentLine, step]);

  if (!currentLine) return null;

  return (
    <div className="announcement">
      <div className="announcement-viewport" ref={viewportRef}>
        <ul className="announcement-list">
          {lines.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
        <span className="announcement-line" ref={lineRef} key={step} aria-hidden="true">
          <span className="live-dot" />
          {currentLine}
        </span>
      </div>
    </div>
  );
}
