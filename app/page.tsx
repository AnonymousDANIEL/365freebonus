import type { Metadata } from 'next';
import { cache } from 'react';
import DirectoryClient from './DirectoryClient';
import NoticeCarousel from './components/NoticeCarousel';
import { getAdminPath } from './lib/auth-core';
import { defaultAvatarImageUrl } from './lib/brand-media';
import { isSafeImageUrl } from './lib/image-url';
import { readPublicPopupNotices, type PopupNotice } from './lib/popup-notices';
import { PUBLIC_SITE_URL } from './lib/public-brand-pages';
import { readDirectory } from './lib/server-directory';
export const dynamic = 'force-dynamic';

const title = 'Free Bonus Malaysia | 365 Free Bonus';
const description = 'Explore free bonus information for Malaysia with 365 Free Bonus. Browse listed brands and check provider terms before joining.';
const homeUrl = PUBLIC_SITE_URL + '/';
const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: '365 Free Bonus',
  alternateName: '365FreeBonus',
  url: homeUrl,
};

const readHome = cache(async () => {
  const now = Date.now();
  const data = await readDirectory(false, now, getAdminPath());
  return { data, now };
});

export async function generateMetadata(): Promise<Metadata> {
  const { data: { settings } } = await readHome();
  const savedAvatar = settings.avatarImageUrl;
  const avatar = savedAvatar && isSafeImageUrl(savedAvatar) ? savedAvatar : defaultAvatarImageUrl;
  const shareImage = settings.coverImageUrl && isSafeImageUrl(settings.coverImageUrl) ? settings.coverImageUrl : avatar;
  return {
    title,
    description,
    alternates: { canonical: homeUrl },
    icons: { icon: avatar, apple: avatar },
    openGraph: {
      type: 'website',
      siteName: '365 Free Bonus',
      url: homeUrl,
      title,
      description,
      images: [{ url: shareImage, alt: '365 Free Bonus' }],
    },
  };
}

export default async function Home() {
  // A failed directory load must be an HTTP error, not a successful empty page.
  const { data, now } = await readHome();
  let notices: PopupNotice[] = [];
  try {
    notices = readPublicPopupNotices();
  } catch (error) {
    console.error('Popup notices could not be loaded.', error);
  }
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteSchema) }} />
    <DirectoryClient initialData={data} initialTime={now} />
    {notices.length > 0 && <NoticeCarousel notices={notices} />}
  </>;
}
