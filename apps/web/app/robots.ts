import type { MetadataRoute } from 'next';

/**
 * The app host is not for crawlers.
 *
 * Since the marketing site moved to libriant.com, this host serves the product
 * — plus a landing page at /el and /en that would otherwise compete with the
 * real site for the same queries and split its ranking. Everything else here is
 * behind a login and has nothing to offer an index either.
 *
 * The marketing site publishes its own robots.txt and sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/' },
  };
}
