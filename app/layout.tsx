import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NMWC Customer Master',
  description: 'NMWC field customer master data management',
  icons: { icon: '/favicon.ico' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-slate-50 font-sans text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
