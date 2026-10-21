import { deploymentDefaults } from '@cat-cafe/shared';
import { SettingsShell } from '@/components/settings/SettingsShell';

export const metadata = { title: `设置 — ${deploymentDefaults.brand.name}` };
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return <SettingsShell />;
}
