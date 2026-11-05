'use client';
import { useRef } from 'react';

export default function BrandScene() {
  const ref = useRef<HTMLDivElement>(null);
  return <div className="brand-scene" ref={ref} aria-hidden="true" onPointerMove={event=>{
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const bounds=event.currentTarget.getBoundingClientRect();
    ref.current?.style.setProperty('--scene-x',`${((event.clientX-bounds.left)/bounds.width-.5)*7}deg`);
    ref.current?.style.setProperty('--scene-y',`${-((event.clientY-bounds.top)/bounds.height-.5)*5}deg`);
  }} onPointerLeave={()=>{ref.current?.style.setProperty('--scene-x','0deg');ref.current?.style.setProperty('--scene-y','0deg');}}>
    <div className="brand-scene-halo"/>
    <div className="brand-scene-image"><img src="/brand/cover.webp" alt="" fetchPriority="high" draggable="false"/></div>
    <div className="brand-scene-sheen"/>
    <span className="scene-glint glint-one">✦</span><span className="scene-glint glint-two">✦</span>
  </div>;
}
