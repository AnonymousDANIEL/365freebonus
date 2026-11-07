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
        <clipPath id={id('above-rim')}><path d={ABOVE_FRONT_RIM} /></clipPath>
        <radialGradient id={id('bloom')} cx="50%" cy="80%" r="57%">
          <stop stopColor="#ffebad" stopOpacity=".72" />
          <stop offset=".45" stopColor="#ffb34d" stopOpacity=".30" />
          <stop offset="1" stopColor="#f98328" stopOpacity="0" />
        </radialGradient>
      </defs>
      <image data-gift-plate href={openingPlateUrl} width="1448" height="1086" />
      <path data-gift-interior d={INSIDE_BOX} fill="#1e0a19" opacity=".94" />
      <g clipPath={url('above-rim')}>
        <ellipse data-gift-bloom cx="724" cy="678" rx="338" ry="141" fill={url('bloom')} opacity="0" />
        <g data-gift-wordmark opacity="0" transform="translate(0 310)">
          <g clipPath={url('wordmark')}>
            <use href={ref('original')} />
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
