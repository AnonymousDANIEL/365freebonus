'use client';

import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { defaultCoverImageUrl, defaultCoverPosterUrl } from '../lib/brand-media';

type BrandSceneProps = {
  coverImageUrl: string;
  language: 'EN' | 'BM' | '中文';
};

const motionLabels = {
  EN: { play: 'Play animation', pause: 'Pause animation' },
  BM: { play: 'Mainkan animasi', pause: 'Jeda animasi' },
  '中文': { play: '播放动画', pause: '暂停动画' },
};

export default function BrandScene({ coverImageUrl, language }: BrandSceneProps) {
  const [paused, setPaused] = useState(false);
  const useDefaultCover = !coverImageUrl || coverImageUrl === defaultCoverImageUrl;
  const labels = motionLabels[language];

  return (
    <div className="brand-scene">
      <div className="brand-scene-halo" aria-hidden="true" />
      <picture className="brand-scene-image">
        {useDefaultCover && (
          <source media="(prefers-reduced-motion: reduce)" srcSet={defaultCoverPosterUrl} />
        )}
        <img
          src={useDefaultCover ? (paused ? defaultCoverPosterUrl : defaultCoverImageUrl) : coverImageUrl}
          alt=""
          fetchPriority="high"
          draggable={false}
        />
      </picture>
      {useDefaultCover && (
        <button
          type="button"
          className="brand-motion-toggle"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? labels.play : labels.pause}
          title={paused ? labels.play : labels.pause}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
      )}
    </div>
  );
}
