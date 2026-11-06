import { useId } from 'react';
import './gift-opening.css';

// All coordinates match the original 1448 × 1086 artwork. Only the cutout
// layers move; the final frame is always the exact, untransformed original.
const LID = 'M298 291 C318 263 363 229 428 219 C419 204 408 178 421 145 C435 106 469 77 502 68 C562 51 633 96 678 174 C695 168 751 169 769 177 C813 107 873 72 925 68 C976 64 1004 101 1020 130 C1032 160 1023 192 997 220 C1062 219 1107 248 1145 289 L1114 282 C1121 306 1124 327 1125 354 C1111 328 1094 306 1077 289 C1080 315 1085 344 1088 367 Q1088 376 1071 384 L1034 394 L1037 383 L423 383 L418 402 Q389 395 355 375 Q358 342 369 295 C349 310 330 332 318 354 C319 327 326 302 334 280 Z M488 125 C469 174 510 205 601 208 L664 218 C625 180 564 132 488 125 Z M957 128 C976 177 936 205 851 208 L785 218 C824 182 884 135 957 128 Z';
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
        <clipPath id={id('lid')}><path d={LID} clipRule="evenodd" /></clipPath>
        <clipPath id={id('wordmark')}><path d={WORDMARK} /></clipPath>
        <clipPath id={id('above-rim')}><path d={ABOVE_FRONT_RIM} /></clipPath>
        <filter id={id('gold-matte')} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 3.6 0 0 -.99" result="matte" />
          <feComposite in="SourceGraphic" in2="matte" operator="in" />
        </filter>
        <radialGradient id={id('bloom')} cx="50%" cy="80%" r="57%">
          <stop stopColor="#ffebad" stopOpacity=".72" />
          <stop offset=".45" stopColor="#ffb34d" stopOpacity=".30" />
          <stop offset="1" stopColor="#f98328" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1448" height="1086" fill="#200b20" />
      <image data-gift-plate href={openingPlateUrl} width="1448" height="1086" />
      <path data-gift-interior d={INSIDE_BOX} fill="#1e0a19" opacity=".94" />
      <g clipPath={url('above-rim')}>
        <ellipse data-gift-bloom cx="724" cy="678" rx="338" ry="141" fill={url('bloom')} opacity="0" />
        <g data-gift-wordmark opacity="0" transform="translate(0 310)">
          <g clipPath={url('wordmark')}>
            <use href={ref('original')} filter={url('gold-matte')} />
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
      <div className="brand-scene-halo" aria-hidden="true" />
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
