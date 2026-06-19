'use client';

/**
 * ConnectorActionBar — save/test buttons + status display for a connector card.
 * Extracted from HubConnectorConfigTab to manage file size.
 */

import { WifiIcon } from './HubConfigIcons';

interface Props {
  platformId: string;
  saveResult: { type: 'success' | 'error'; message: string } | null;
  saving: boolean;
  onSave: () => void;
  /** Show test button only when connector has a test handler (YAML action or built-in). */
  showTest?: boolean;
  testing: boolean;
  onTest: () => void;
}

export function ConnectorActionBar({
  platformId,
  saveResult,
  saving,
  onSave,
  showTest = true,
  testing,
  onTest,
}: Props) {
  return (
    <>
      {saveResult && (
        <div
          className={`rounded-2xl px-3 py-2 text-xs ${
            saveResult.type === 'success'
              ? 'bg-conn-emerald-bg text-conn-emerald-text border border-conn-emerald-ring'
              : 'bg-conn-red-bg text-conn-red-text border border-conn-red-ring'
          }`}
          data-testid="save-result"
        >
          {saveResult.message}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {showTest && (
          <button
            type="button"
            className="console-button-secondary text-sm disabled:opacity-50"
            onClick={onTest}
            disabled={testing}
          >
            <WifiIcon />
            {testing ? '测试中...' : '测试连接'}
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="console-button-primary text-sm disabled:opacity-50"
          data-testid={`save-${platformId}`}
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </>
  );
}
