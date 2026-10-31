import { PluginsContent } from '@/components/settings/PluginsContent';
import { ConfirmProvider } from '@/components/useConfirm';

export function SettingsContent({ section }: { section: string }) {
  return (
    <ConfirmProvider>
      <section data-testid="settings-owner" data-section={section}>
        {section === 'plugins' ? <PluginsContent /> : section}
      </section>
    </ConfirmProvider>
  );
}
export function OklchTuner() {
  return null;
}
export default OklchTuner;
