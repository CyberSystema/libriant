import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Libriant',
  description: 'Library management, made simple.',
};

/**
 * Root layout exists only to bounce visitors of `/` to a locale-prefixed URL.
 * All real rendering happens under app/[locale]/.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}

// Note: app/page.tsx redirects to a negotiated locale; see that file.
