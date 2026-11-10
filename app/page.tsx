import type { Metadata } from 'next';
import Script from 'next/script';
import DirectoryClient from './DirectoryClient';
import NoticeCarousel from './components/NoticeCarousel';
import { readPublicPopupNotices, type PopupNotice } from './lib/popup-notices';
import { readDirectory } from './lib/server-directory';
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  try {
    const { settings } = await readDirectory();
    const avatar = settings.avatarImageUrl;
    return {
      title: '365 Free Bonus',
      ...(avatar && { icons: { icon: avatar, apple: avatar } }),
    };
  } catch {
    return {};
  }
}

export default async function Home() {
  try {
    const now = Date.now();
    const data = await readDirectory(false, now);
    let notices: PopupNotice[] = [];
    try {
      notices = readPublicPopupNotices();
    } catch (error) {
      console.error('Popup notices could not be loaded.', error);
    }
    return <>
      <DirectoryClient initialData={data} initialTime={now} />
      {notices.length > 0 && <NoticeCarousel notices={notices} />}
      <Script src="/front-pause.js" strategy="afterInteractive" />
    </>;
  } catch {
    return <main className="site-error"><span className="brandmark">N</span><h1>We couldn’t load the collection.</h1><p>Please refresh in a moment. Your saved content has not been changed.</p><a href="/">Try again ↗</a></main>;
  }
}
