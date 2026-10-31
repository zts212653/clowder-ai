'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsStatusStrip } from '../primitives/SettingsStatusStrip';
import { PluginConfigurationActionBar } from './PluginConfigurationActionBar';

type TestResult = { readonly ok: boolean; readonly message: string };

function testResponse(response: Response, body: { ok?: unknown; message?: unknown; error?: unknown }): TestResult {
  if (!response.ok)
    return { ok: false, message: typeof body.error === 'string' ? body.error : `测试连接失败 (${response.status})` };
  return {
    ok: body.ok === true,
    message: typeof body.message === 'string' ? body.message : body.ok === true ? '连接测试成功' : '连接测试失败',
  };
}

export function PluginManagerConfigurationActions({
  pluginId,
  feedbackKey,
  busy,
  saved,
  showSave,
  saveDisabled,
  testable,
  onSave,
}: {
  pluginId: string;
  feedbackKey: string;
  busy: boolean;
  saved: boolean;
  showSave: boolean;
  saveDisabled: boolean;
  testable: boolean;
  onSave: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const request = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the configuration identity invalidates test feedback and pending requests.
  useEffect(() => {
    setTestResult(null);
    setTesting(false);
    return () => request.current?.abort();
  }, [feedbackKey]);
  useEffect(() => {
    if (!testResult?.ok) return;
    const timer = setTimeout(() => setTestResult(null), 4000);
    return () => clearTimeout(timer);
  }, [testResult]);

  const runTest = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/test`, {
        method: 'POST',
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: unknown; message?: unknown; error?: unknown };
      if (controller.signal.aborted) return;
      setTestResult(testResponse(response, body));
    } catch {
      if (controller.signal.aborted) return;
      setTestResult({ ok: false, message: '连接测试失败；请检查网络后重试。' });
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  };

  return (
    <div className="space-y-2">
      {saved && <SettingsStatusStrip tone="success">配置已保存</SettingsStatusStrip>}
      {testResult && (
        <SettingsStatusStrip tone={testResult.ok ? 'success' : 'error'}>{testResult.message}</SettingsStatusStrip>
      )}
      <PluginConfigurationActionBar
        pluginId={pluginId}
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
