import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '365freebonus — A space for discovery',
  description: 'Explore a curated collection of gaming, lifestyle and digital entertainment brands in one immersive space.',
  icons: { icon: '/brand/avatar.webp', apple: '/brand/avatar.webp' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
