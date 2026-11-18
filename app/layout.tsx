import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';
import './public-light.css';
import './public-soft-light.css';
import './brand-media.css';
import { defaultAvatarImageUrl } from './lib/brand-media';
import { PUBLIC_SITE_URL } from './lib/public-brand-pages';

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_SITE_URL),
  title: '365 Free Bonus',
  icons: { icon: defaultAvatarImageUrl, apple: defaultAvatarImageUrl },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<Script src="/front-pause.js?v=3" strategy="beforeInteractive" /></body></html>;
}
