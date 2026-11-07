import { ArrowUpRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import { isSafeSocialUrl } from '../lib/directory';
import type { SiteSettings } from '../lib/directory';
import './social-contacts.css';

type Lang = 'EN' | 'BM' | '中文';
type Channel = 'whatsapp' | 'telegram' | 'facebook';
type Props = { settings: SiteSettings; lang: Lang };
const words = {
  EN: { kicker: 'A CONVERSATION STARTS HERE', heading: 'Connect with us.', description: 'Choose a channel and say hello.', whatsapp: 'Chat with us', telegram: 'Start a conversation', facebook: 'Visit our page', open: 'Open', newTab: 'opens in a new tab' },
  BM: { kicker: 'PERBUALAN BERMULA DI SINI', heading: 'Hubungi kami.', description: 'Pilih saluran dan sapa kami.', whatsapp: 'Berbual dengan kami', telegram: 'Mulakan perbualan', facebook: 'Lawati halaman kami', open: 'Buka', newTab: 'dibuka dalam tab baharu' },
  '中文': { kicker: '从一句你好开始', heading: '与我们联系。', description: '选择你喜欢的平台，随时与我们打个招呼。', whatsapp: '与我们聊聊', telegram: '开启对话', facebook: '访问我们的主页', open: '打开', newTab: '在新标签页中打开' },
};

function SocialIcon({ channel }: { channel: Channel }) {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
    {channel === 'whatsapp' && <>
      <path d="M26.7 15.5a10.7 10.7 0 0 1-15.8 9.4L5 26.7l1.7-5.8a10.7 10.7 0 1 1 20-5.4Z" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" />
      <path d="m11.7 10.2 1.5 3c.2.4.1.7-.2 1l-.9.9a10.4 10.4 0 0 0 4.8 4.1l.9-1.2c.2-.3.6-.4.9-.2l3 1.4c.3.2.4.4.3.8-.3 1.6-1.5 2.1-2.8 2-4.7-.6-9.8-5.1-10.4-9.5-.2-1.3.6-2.5 1.5-2.7.6-.1 1.1 0 1.4.4Z" fill="currentColor" />
    </>}
    {channel === 'telegram' && <>
      <path d="m5.8 14.4 21-8.1c.7-.3 1.3.2 1.1 1l-3.6 18.1c-.2.8-.8 1.1-1.5.7l-6.3-4.7-3.2 3.1c-.4.4-.8.2-.9-.3l.3-6 10.7-8.4-13 6.9-4.5-1.4c-.8-.3-.8-.7-.1-.9Z" fill="currentColor" />
      <path d="m12.7 18.2 3.8 3.2" stroke="#fff" strokeWidth=".7" opacity=".6" />
    </>}
    {channel === 'facebook' && <path d="M19.3 28V17.3h3.6l.5-4.2h-4.1v-2.7c0-1.2.3-2 2.1-2h2.2V4.6c-.4-.1-1.7-.2-3.2-.2-3.2 0-5.4 1.9-5.4 5.5v3.2h-3.6v4.2H15V28h4.3Z" fill="currentColor" />}
  </svg>;
}

export default function SocialContacts({ settings, lang }: Props) {
  const t = words[lang];
  const channels: { id: Channel; name: string; enabled: boolean; url: string }[] = [
    { id: 'whatsapp', name: 'WhatsApp', enabled: settings.whatsappEnabled, url: settings.whatsappUrl },
    { id: 'telegram', name: 'Telegram', enabled: settings.telegramEnabled, url: settings.telegramUrl },
    { id: 'facebook', name: 'Facebook', enabled: settings.facebookEnabled, url: settings.facebookUrl },
  ];
  const visible = channels
    .map(channel => ({ ...channel, url: typeof channel.url === 'string' ? channel.url.trim() : '' }))
    .filter(channel => channel.enabled === true && isSafeSocialUrl(channel.url));
  if (!visible.length) return null;

  return <section className="social-contacts section-shell" id="contact" aria-labelledby="social-contacts-heading">
    <div className="social-contacts-heading">
      <span className="social-contacts-kicker"><span aria-hidden="true" />{t.kicker}</span>
      <h2 id="social-contacts-heading">{t.heading}</h2>
      <p>{t.description}</p>
    </div>
    <div className="social-contacts-grid" style={{ '--social-count': visible.length } as CSSProperties}>
      {visible.map((channel, index) => <a
        className={`social-contact-card social-contact-${channel.id}`}
        href={channel.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${t.open} ${channel.name} (${t.newTab})`}
        style={{ '--social-index': index } as CSSProperties}
        key={channel.id}
      >
        <span className="social-contact-icon"><SocialIcon channel={channel.id} /></span>
        <span className="social-contact-copy"><strong>{channel.name}</strong><span>{t[channel.id]}</span></span>
        <span className="social-contact-arrow"><ArrowUpRight size={17} aria-hidden="true" /></span>
      </a>)}
    </div>
  </section>;
}
