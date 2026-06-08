import Link from 'next/link';

/**
 * Root not-found document.
 *
 * The root layout (`app/layout.tsx`) is a pass-through and renders no `<html>`,
 * so this page supplies its own. It covers routes that never reach the locale
 * layout — unmatched/non-locale URLs, and the `notFound()` thrown by
 * `app/[locale]/layout.tsx` for an unsupported locale. Kept self-contained
 * (inline styles, no AssetProvider) so it works without the per-locale theme.
 */
export default function NotFound() {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: '#f6f8fa',
          color: '#1f2328',
        }}
      >
        <main style={{ textAlign: 'center', padding: '2rem' }}>
          <h1 style={{ fontSize: '3rem', margin: '0 0 0.5rem' }}>404</h1>
          <p style={{ margin: '0 0 1.5rem', color: '#57606a' }}>This page could not be found.</p>
          <Link href="/" style={{ color: '#1f6feb', textDecoration: 'none', fontWeight: 600 }}>
            Go to Libriant
          </Link>
        </main>
      </body>
    </html>
  );
}
