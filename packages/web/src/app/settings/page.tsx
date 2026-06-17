import { SettingsShell } from '@/components/settings/SettingsShell';

export const metadata = { title: '设置 — Clowder AI' };
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return <SettingsShell />;
}
