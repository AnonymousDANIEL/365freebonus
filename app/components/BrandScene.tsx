import { useId } from 'react';
import './gift-opening.css';

// All coordinates match the original 1448 × 1086 artwork. Only the cutout
// layers move; the final frame is always the exact, untransformed original.
// Native alpha defines the outer ribbon and bow holes. Keep only the lower
// boundary here so their soft edges are never trimmed by an old silhouette.
const LID = 'M0 0 H1448 V383 H1073 L1034 397 L1037 383 H423 L418 405 Q389 395 350 375 H0 Z';
// The scalloped top edge excludes the original lid's warm highlight above 6.
const WORDMARK = 'M397 386 H618 L632 413 H710 Q764 389 841 386 L850 403 H884 Q899 395 922 394 Q1002 395 1040 386 L1035 640 L1019 642 L1019 733 L414 735 L414 644 L398 641 Z';
const ABOVE_FRONT_RIM = 'M0 0 H1448 V760 H1093 Q1040 781 944 787 Q721 805 500 788 Q395 781 350 764 H0 Z';
const INSIDE_BOX = 'M354 765 Q385 735 421 715 Q721 710 1021 715 Q1057 735 1090 765 Q1053 784 950 790 Q720 806 494 790 Q391 784 354 765 Z';
const RAYS = [
  [191, 610, 38], [294, 438, 48], [403, 297, 42], [523, 250, 28],
  [625, 311, 36], [728, 201, 34], [828, 277, 25], [944, 315, 44],
  [1064, 434, 36], [1227, 568, 43],
] as const;

function rayPath(x: number, y: number, width: number) {
  const length = Math.hypot(x - 724, y - 774);
  const sideX = (774 - y) / length * width;
  const sideY = (x - 724) / length * width;
  return `M697 774 L${x - sideX} ${y - sideY} L${x + sideX} ${y + sideY} L751 774 Z`;
}

function GiftOpening({ coverImageUrl, openingPlateUrl }: { coverImageUrl: string; openingPlateUrl: string }) {
  const prefix = useId();
  const id = (key: string) => `${prefix}-${key}`;
  const ref = (key: string) => `#${id(key)}`;
  const url = (key: string) => `url(${ref(key)})`;

  return (
    <svg className="gift-opening" data-gift-opening viewBox="0 0 1448 1086" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <defs>
        <image id={id('original')} href={coverImageUrl} width="1448" height="1086" />
        <clipPath id={id('lid')}><path d={LID} /></clipPath>
        <clipPath id={id('wordmark')}><path d={WORDMARK} /></clipPath>
        <clipPath id={id('digits')}><rect x="390" y="386" width="655" height="257" /></clipPath>
        <clipPath id={id('subtitle')}><rect x="410" y="643" width="615" height="94" /></clipPath>
        <clipPath id={id('above-rim')}><path d={ABOVE_FRONT_RIM} /></clipPath>
        <filter id={id('intro-gold-matte')} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 3.6 0 0 -.99" result="matte" />
          <feComposite in="SourceGraphic" in2="matte" operator="in" />
        </filter>
        <radialGradient id={id('bloom')}>
          <stop stopColor="#fff9d9" stopOpacity=".92" />
          <stop offset=".25" stopColor="#ffe9a2" stopOpacity=".72" />
          <stop offset=".58" stopColor="#ffbd55" stopOpacity=".32" />
          <stop offset="1" stopColor="#f9a33b" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('core')}>
          <stop stopColor="#fffef1" />
          <stop offset=".27" stopColor="#fff4bc" stopOpacity=".95" />
          <stop offset=".64" stopColor="#ffd16d" stopOpacity=".55" />
          <stop offset="1" stopColor="#ffc263" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id('ray-light')} x1="724" y1="774" x2="724" y2="220" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff9d6" stopOpacity=".96" />
          <stop offset=".2" stopColor="#ffe8a0" stopOpacity=".76" />
          <stop offset=".63" stopColor="#ffcb69" stopOpacity=".26" />
          <stop offset="1" stopColor="#ffc05c" stopOpacity="0" />
        </linearGradient>
        <filter id={id('ray-soft')} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      <image data-gift-plate href={openingPlateUrl} width="1448" height="1086" />
      <path data-gift-interior d={INSIDE_BOX} fill="#1e0a19" opacity=".94" />
      <g clipPath={url('above-rim')}>
        <g data-gift-rays opacity="0">
          <g fill={url('ray-light')} filter={url('ray-soft')}>
            {RAYS.map(([x, y, width], index) => <path key={index} d={rayPath(x, y, width)} opacity={index % 3 === 0 ? '.88' : '.62'} />)}
          </g>
          <g fill={url('ray-light')} opacity=".60">
            <path d="M715 776 516 352 539 344 733 776Z" />
            <path d="M713 776 720 285 735 285 736 776Z" />
            <path d="M717 776 942 395 953 403 735 776Z" />
          </g>
          <g fill="#fff1bd" opacity=".8">
            <path d="m348 594 4 11 11 4-11 4-4 11-4-11-11-4 11-4Z" />
            <path d="m1072 544 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" />
            <path d="m614 475 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
          </g>
        </g>
        <g data-gift-bloom opacity="0">
          <ellipse cx="724" cy="714" rx="382" ry="191" fill={url('bloom')} />
          <ellipse cx="724" cy="768" rx="292" ry="48" fill={url('core')} />
          <ellipse cx="724" cy="767" rx="198" ry="15" fill={url('core')} />
        </g>
        <g data-gift-wordmark>
          <g data-gift-digits opacity="0" transform="translate(0 310)">
            <g clipPath={url('wordmark')}>
              <g clipPath={url('digits')}><use href={ref('original')} filter={url('intro-gold-matte')} /></g>
            </g>
          </g>
          <g data-gift-subtitle opacity="0" transform="translate(0 170)">
            <g clipPath={url('wordmark')}>
              <g clipPath={url('subtitle')}><use href={ref('original')} filter={url('intro-gold-matte')} /></g>
            </g>
          </g>
        </g>
      </g>
      <g data-gift-lid transform="translate(0 411)" clipPath={url('lid')}>
        <use href={ref('original')} />
        <path data-gift-lid-shade d="M350 377 Q386 350 429 333 H1010 Q1055 351 1092 367 L1092 410 H350 Z" fill="#210e18" opacity=".92" />
      </g>
    </svg>
  );
}

export default function BrandScene({ coverImageUrl, openingPlateUrl }: { coverImageUrl: string; openingPlateUrl?: string }) {
  return (
    <div className="brand-scene">
      <div className={`brand-scene-image${openingPlateUrl ? ' has-gift-opening' : ''}`}>
        <img className={openingPlateUrl ? 'gift-opening-poster' : undefined} src={coverImageUrl} alt="" fetchPriority="high" draggable={false} />
        {openingPlateUrl && <>
          <GiftOpening coverImageUrl={coverImageUrl} openingPlateUrl={openingPlateUrl} />
          <noscript dangerouslySetInnerHTML={{ __html: '<style>.gift-opening{display:none}.brand-scene-image .gift-opening-poster{opacity:1}</style>' }} />
        </>}
      </div>
    </div>
  );
}
