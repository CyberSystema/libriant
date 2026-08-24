import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { negotiateLocale } from '@libriant/i18n';
import { preferredLocaleFromCookies } from '@/lib/locale-preference-server';

export default async function RootIndex() {
  // A language the visitor picked in the app outranks their browser's
  // Accept-Language: Greek libraries routinely run their machines in en-US, and
  // negotiateLocale short-circuits to 'en' for any en-* tag.
  const remembered = await preferredLocaleFromCookies();
  if (remembered) redirect(`/${remembered}`);
  const accept = (await headers()).get('accept-language');
  const locale = negotiateLocale(accept);
  redirect(`/${locale}`);
}
