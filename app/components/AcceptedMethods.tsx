import type { CSSProperties } from 'react';
import { Landmark, Smartphone, Sparkles } from 'lucide-react';
import './accepted-methods.css';

type Lang = 'EN' | 'BM' | '中文';
type Country = 'MY' | 'ID' | 'TH';
const text = {
  EN: { eyebrow: 'ACROSS BORDERS', title: 'We accept', malaysia: 'Malaysia', indonesia: 'Indonesia', thailand: 'Thailand', bank: 'Bank transfer', telco: 'Telco reload', asset: 'Digital asset' },
  BM: { eyebrow: 'MERENTASI SEMPADAN', title: 'Kami menerima', malaysia: 'Malaysia', indonesia: 'Indonesia', thailand: 'Thailand', bank: 'Pindahan bank', telco: 'Tambah nilai telco', asset: 'Aset digital' },
  '中文': { eyebrow: '跨越边界，轻松连接', title: '我们接受', malaysia: '马来西亚', indonesia: '印度尼西亚', thailand: '泰国', bank: '银行转账', telco: '手机充值', asset: '数字资产' },
};

function CountryFlag({ country }: { country: Country }) {
  if (country === 'ID') return <svg viewBox="0 0 42 28" aria-hidden="true"><path fill="#fff" d="M0 0h42v28H0z" /><path fill="#d93e48" d="M0 0h42v14H0z" /></svg>;
  if (country === 'TH') return <svg viewBox="0 0 42 28" aria-hidden="true"><path fill="#bd344b" d="M0 0h42v28H0z" /><path fill="#fff" d="M0 4.67h42v18.66H0z" /><path fill="#393064" d="M0 9.33h42v9.34H0z" /></svg>;
  const star = Array.from({ length: 28 }, (_, index) => {
    const angle = index * Math.PI / 14 - Math.PI / 2;
    const radius = index % 2 ? 2.05 : 4.1;
    return `${15.9 + Math.cos(angle) * radius},${7.5 + Math.sin(angle) * radius}`;
  }).join(' ');
  return <svg viewBox="0 0 42 28" aria-hidden="true">
    <path fill="#fff" d="M0 0h42v28H0z" />
    {Array.from({ length: 7 }, (_, index) => <path key={index} fill="#c63749" d={`M0 ${index * 4}h42v2H0z`} />)}
    <path fill="#293b76" d="M0 0h23v16H0z" />
    <circle cx="8.2" cy="8" r="5.2" fill="#f0cd58" />
    <circle cx="10" cy="7.2" r="4.7" fill="#293b76" />
    <polygon fill="#f0cd58" points={star} />
  </svg>;
}

function UsdtMark() {
  return <svg viewBox="0 0 56 56" aria-hidden="true">
    <circle cx="28" cy="28" r="27" fill="#e3f3ee" />
    <circle cx="28" cy="28" r="22" fill="#4b9684" />
    <path fill="#fff" d="M16 14h24v5H30.5v17h-5V19H16z" />
    <ellipse cx="28" cy="25" rx="14" ry="4.3" fill="none" stroke="#fff" strokeWidth="1.7" />
    <path stroke="#fff" strokeWidth="5" d="M28 27v13" />
  </svg>;
}

export default function AcceptedMethods({ lang }: { lang: Lang }) {
  const t = text[lang];
  const methods = [
    { id: 'my-bank', country: 'MY' as Country, label: t.malaysia, type: t.bank, Icon: Landmark },
    { id: 'my-telco', country: 'MY' as Country, label: t.malaysia, type: t.telco, Icon: Smartphone },
    { id: 'usdt', label: 'USDT', type: t.asset },
    { id: 'id-bank', country: 'ID' as Country, label: t.indonesia, type: t.bank, Icon: Landmark },
    { id: 'th-bank', country: 'TH' as Country, label: t.thailand, type: t.bank, Icon: Landmark },
  ];
  return <section className="accepted-methods" aria-label={t.title}>
    <div className="section-shell">
      <div className="accepted-methods-panel">
        <div className="accepted-methods-heading">
          <span className="accepted-methods-eyebrow"><Sparkles size={12} aria-hidden="true" />{t.eyebrow}</span>
          <h2>{t.title}</h2>
        </div>
        <ul className="accepted-methods-grid">
          {methods.map((method, index) => <li className={`accepted-method-card${method.id === 'usdt' ? ' is-usdt' : ''}`} key={method.id} style={{ '--method-index': index } as CSSProperties}>
            <span className="accepted-method-visual" aria-hidden="true">
              {method.country ? <><span className="accepted-method-flag"><CountryFlag country={method.country} /></span><span className="accepted-method-symbol">{method.Icon && <method.Icon size={19} strokeWidth={1.35} />}</span></> : <span className="accepted-method-usdt"><UsdtMark /></span>}
            </span>
            <span className="accepted-method-country">{method.label}</span>
            <strong>{method.type}</strong>
          </li>)}
        </ul>
      </div>
    </div>
  </section>;
}
