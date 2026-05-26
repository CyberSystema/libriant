import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import { resolveAssetPath } from '@/lib/assets-server';

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export async function GET(_req: Request, { params }: { params: { path: string[] } }) {
  const rel = params.path.join('/');
  const full = resolveAssetPath(rel);
  if (!full) return new NextResponse('Not found', { status: 404 });

  try {
    const buf = await fs.readFile(full);
    const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    return new NextResponse(buf, {
      headers: {
        'content-type': mime,
        // Short cache so designers can hot-swap files and see results quickly.
        'cache-control': 'public, max-age=60, must-revalidate',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
