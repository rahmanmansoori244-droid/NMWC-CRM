import './print.css';

/**
 * The printouts' own layout (owner decisions 2026-10-11, part C): outside the
 * (app) group, so no top bar, menu or tab bar renders around a printout — and
 * none can print. It adds only the printouts' stylesheet; the root layout still
 * supplies <html> and <body> (and the CSP nonce). Each page
 * under it calls auth() and redirects to /login itself: the middleware does not
 * gate a page (auth.config.ts).
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
