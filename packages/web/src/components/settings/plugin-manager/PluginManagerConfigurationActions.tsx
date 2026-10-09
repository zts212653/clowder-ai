'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ConnectorActionBar } from '../../ConnectorActionBar';
import { SettingsStatusStrip } from '../primitives/SettingsStatusStrip';

type TestResult = { readonly ok: boolean; readonly message: string };

export function PluginManagerConfigurationActions({
  pluginId,
  busy,
  saved,
  showSave,
  saveDisabled,
  testable,
  onSave,
}: {
  pluginId: string;
  busy: boolean;
  saved: boolean;
  showSave: boolean;
  saveDisabled: boolean;
  testable: boolean;
  onSave: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/test`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { ok?: unknown; message?: unknown; error?: unknown };
      if (!response.ok) {
        setTestResult({
          ok: false,
          message: typeof body.error === 'string' ? body.error : `测试连接失败 (${response.status})`,
        });
        return;
      }
      setTestResult({
        ok: body.ok === true,
        message: typeof body.message === 'string' ? body.message : body.ok === true ? '连接测试成功' : '连接测试失败',
      });
    } catch {
      setTestResult({ ok: false, message: '连接测试失败；请检查网络后重试。' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-2">
      {saved && <SettingsStatusStrip tone="success">配置已保存</SettingsStatusStrip>}
      {testResult && (
        <SettingsStatusStrip tone={testResult.ok ? 'success' : 'error'}>{testResult.message}</SettingsStatusStrip>
      )}
      <ConnectorActionBar
        platformId={pluginId}
        saveResult={null}
        saving={busy}
        onSave={onSave}
        showSave={showSave}
        saveDisabled={saveDisabled}
        showTest={testable}
        testing={testing}
        onTest={() => void runTest()}
      />
    </div>
  );
}
