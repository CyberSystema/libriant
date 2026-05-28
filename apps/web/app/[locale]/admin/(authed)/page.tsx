import { redirect } from 'next/navigation';

export default function AdminHome({ params }: { params: { locale: string } }) {
  redirect(`/${params.locale}/admin/tenants`);
}
