'use client';

/**
 * DO-04: the last-resort boundary.
 *
 * `app/error.tsx` only catches errors below the root layout. An error thrown by
 * the root layout itself — or by anything it renders before the segment
 * boundary mounts — falls through to Next's built-in page, which reports
 * nothing anywhere. This one catches those and reports them.
 *
 * It replaces the whole document, so it carries its own html and body tags and
 * must not assume any layout, provider or stylesheet loaded successfully.
 * Inline styles for exactly that reason.
 */
import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#f8fafc',
          color: '#0f172a',
          font: '16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        <main style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0 0 .5rem' }}>
            Something went wrong.
          </h1>
          <p style={{ margin: '0 0 1rem', color: '#475569', fontSize: '.875rem' }}>
            The page could not be loaded. Reloading usually fixes it. Nothing you saved has been
            lost.
          </p>
          {error.digest && (
            <p
              style={{
                margin: '0 0 1rem',
                fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                fontSize: '11px',
                color: '#94a3b8',
                wordBreak: 'break-all',
              }}
            >
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              font: 'inherit',
              fontSize: '.875rem',
              padding: '8px 16px',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
