import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { negotiateLocale } from '@libriant/i18n';

export default async function RootIndex() {
  const accept = (await headers()).get('accept-language');
  const locale = negotiateLocale(accept);
  redirect(`/${locale}`);
}
