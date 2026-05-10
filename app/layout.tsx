import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: 'NMWC Customer Master',
  description: 'NMWC field customer master data management',
  icons: { icon: '/favicon.ico' },
};

/**
 * B-13 (Senior-audit 2026-05-10): reading the `x-nonce` header here is what
 * makes Next.js stamp the same nonce onto its own automatic inline scripts
 * (RSC bootstrap `<script>(self.__next_f=...)</script>`, hydration payload,
 * etc.). Without this `headers()` call, the framework wouldn't know there
 * is a nonce policy and the inline bootstrap would emit unstamped — which
 * would be blocked by the strict CSP. The variable doesn't need to be used
 * directly in the JSX; merely calling `headers()` in the layout is enough
 * to trigger the propagation.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce');
  return (
    <html lang="en" className="h-full" data-nonce={nonce ?? undefined}>
      <body className="h-full bg-slate-50 font-sans text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
