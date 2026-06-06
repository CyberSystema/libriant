import type { ResourceType } from './drivers/storage-driver.js';

/**
 * Which MIME types are accepted per resource. Clients can lie about
 * Content-Type, so we ALSO serve uploaded files with
 * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
 * to neutralise the "HTML uploaded as JPEG" attack surface.
 *
 * Tightening this list later is safe: existing files keep working
 * (the check only runs on upload).
 */
export const ALLOWED_TYPES: Record<ResourceType, readonly string[]> = {
  covers: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  members: ['image/jpeg', 'image/png', 'image/webp'],
  attachments: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'],
  marc: ['application/marc', 'application/marcxml+xml', 'text/plain'],
};

/** Friendly human message when a type is rejected. */
export function rejectedMessage(resourceType: ResourceType, contentType: string): string {
  const allowed = ALLOWED_TYPES[resourceType];
  return `"${contentType}" isn't allowed for ${resourceType}. Allowed: ${allowed.join(', ')}.`;
}
