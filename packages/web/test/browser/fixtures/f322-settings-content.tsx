import { useState } from 'react';
import type { ConfigData } from '@/components/config-viewer-types';
import { ExecutionRecordDefaultSettings } from '@/components/settings/ExecutionRecordDefaultSettings';
import { InstallPreviewModal } from '@/components/settings/InstallPreviewModal';
import { useShellPresentation } from '@/components/shell/shell-presentation';

const S5_CONFIG = {
  cats: {},
  perCatCapacities: {},
  a2a: { enabled: true, maxDepth: 3 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  governance: { degradationEnabled: true, doneTimeoutMs: 1, heartbeatIntervalMs: 1 },
  ui: { bubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' } },
} satisfies ConfigData;

function SettingsS5Fixture() {
  const isV2 = useShellPresentation() === 'v2';
  const [config, setConfig] = useState<ConfigData>(S5_CONFIG);
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <div className="space-y-4">
      {isV2 ? (
        <ExecutionRecordDefaultSettings
          config={config}
          hasLoadError={false}
          onConfigChange={setConfig}
          onRetry={() => undefined}
        />
      ) : null}
      <button type="button" data-testid="open-install-preview" onClick={() => setPreviewOpen(true)}>
        Open install preview
      </button>
      <InstallPreviewModal
        open={previewOpen}
        serviceId="fixture-service"
        serviceName="Fixture Service"
        estimatedMinutes={8}
        onConfirm={() => setPreviewOpen(false)}
        onCancel={() => setPreviewOpen(false)}
      />
    </div>
  );
}

// Domain rendering is outside the shell journey. The real SettingsShell owns selection,
// query preservation and pin controls; this boundary reveals which owner it selected.
export function SettingsContent({ section, initialEditCatId }: { section: string; initialEditCatId?: string }) {
  return (
    <section data-testid="settings-owner" data-section={section} data-cat={initialEditCatId ?? ''}>
      {section}
      {section === 'system' ? <SettingsS5Fixture /> : null}
    </section>
  );
}
export function OklchTuner() {
  return null;
}
export default OklchTuner;
