import { NextResponse } from 'next/server';
import { isLocale } from '@libriant/i18n';
import { isValidNamespace, loadCatalog } from '@/lib/locale-loader';

export async function GET(
  _req: Request,
  { params }: { params: { locale: string; namespace: string } },
) {
  if (!isLocale(params.locale)) return new NextResponse('Unknown locale', { status: 404 });
  if (!isValidNamespace(params.namespace))
    return new NextResponse('Unknown namespace', { status: 404 });

  const catalog = await loadCatalog(params.locale, [params.namespace]);
  return NextResponse.json(catalog, {
    headers: { 'cache-control': 'public, max-age=60, must-revalidate' },
  });
}
