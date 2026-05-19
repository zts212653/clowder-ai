'use client';

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { FeishuQrPanel } from './FeishuQrPanel';
import {
  connStatePill,
  DEFAULT_VISUAL,
  ExternalLinkIcon,
  formatHeartbeat,
  LockIcon,
  PERMISSION_CONNECTORS,
  PLATFORM_VISUALS,
  type PlatformStatus,
  StepBadge,
  WifiIcon,
} from './HubConfigIcons';
import { WeComBotSetupPanel } from './WeComBotSetupPanel';
import { WeixinQrPanel } from './WeixinQrPanel';

const HubPermissionsTab = lazy(() => import('./HubPermissionsTab'));

const REDACTED_PLACEHOLDER = '••••••';

function ConnectorActionBar({
  platformId,
  saveResult,
  saving,
  onSave,
  testing,
  onTest,
}: {
  platformId: string;
  saveResult: { type: 'success' | 'error'; message: string } | null;
  saving: boolean;
  onSave: () => void;
  testing: boolean;
  onTest: () => void;
}) {
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
        <button
          type="button"
          className="console-button-secondary text-sm disabled:opacity-50"
          onClick={onTest}
          disabled={testing}
        >
          <WifiIcon />
          {testing ? '测试中...' : '测试连接'}
        </button>
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

export function HubConnectorConfigTab() {
  const activeGuideStep = useGuideStore((s) => {
    const session = s.session;
    if (!session || session.currentStepIndex >= session.flow.steps.length) return null;
    return session.flow.steps[session.currentStepIndex];
  });
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = await res.json();
      const all: PlatformStatus[] = data.platforms ?? [];
      setPlatforms(all.filter((p) => p.category !== 'plugin'));
    } catch {
      // fall through
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleExpand = (platformId: string) => {
    const guideToggleTarget = `connector.${platformId}`;
    if (expandedId === platformId) {
      if (activeGuideStep?.advance === 'click' && activeGuideStep.target === guideToggleTarget) {
        return;
      }
      setExpandedId(null);
      setFieldValues({});
      setSaveResult(null);
      return;
    }
    setExpandedId(platformId);
    setFieldValues({});
    setSaveResult(null);
  };

  const handleSave = async (platform: PlatformStatus) => {
    // F136 Phase 2: all connector fields go through /api/config/secrets (hot-reload enabled)
    const updates = platform.fields
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] || null }));

    if (updates.length === 0) {
      setSaveResult({ type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    if (updates.some((update) => update.value?.includes(REDACTED_PLACEHOLDER))) {
      setSaveResult({ type: 'error', message: '不能保存脱敏占位符，请输入新的完整凭据' });
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveResult({ type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setSaveResult({ type: 'success', message: '配置已保存，连接器正在自动重连...' });
      setFieldValues({});
      await fetchStatus();
    } catch {
      setSaveResult({ type: 'error', message: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (platform: PlatformStatus) => {
    setTesting(true);
    setSaveResult(null);
    try {
      const res = await apiFetch(`/api/connector/${encodeURIComponent(platform.id)}/test`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as { valid?: boolean; error?: string };
      if (data.valid) {
        setSaveResult({ type: 'success', message: '连接正常' });
      } else {
        setSaveResult({ type: 'error', message: data.error || '连接失败' });
      }
    } catch {
      setSaveResult({ type: 'error', message: '网络错误' });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return <p className="text-center text-cafe-muted py-8 text-sm">加载中...</p>;
  }

  if (platforms.length === 0) {
    return <p className="text-center text-cafe-muted py-8 text-sm">无法加载平台配置信息</p>;
  }

  return (
    <div className="space-y-5">
      {platforms.map((platform) => {
        const isExpanded = expandedId === platform.id;
        const v = PLATFORM_VISUALS[platform.id] ?? DEFAULT_VISUAL;
        // Resolve current connection mode for mode-filtered steps
        const modeField = platform.fields.find((f) => f.envName === 'FEISHU_CONNECTION_MODE');
        const selectedMode = modeField
          ? (fieldValues['FEISHU_CONNECTION_MODE'] ?? modeField.currentValue ?? 'webhook')
          : undefined;
        const filteredSteps = platform.steps.filter((s) => !s.mode || s.mode === selectedMode);
        const guideSteps = filteredSteps.slice(0, -1);

        return (
          <div
            key={platform.id}
            className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)] hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)]"
            data-testid={`platform-card-${platform.id}`}
            data-guide-id={`connector.${platform.id}`}
            data-active={isExpanded ? 'true' : 'false'}
          >
            <button
              type="button"
              onClick={() => handleExpand(platform.id)}
              className="flex w-full items-center gap-4 px-5 py-[18px] transition-colors"
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-xl shrink-0"
                style={{ backgroundColor: v.iconBg, color: v.iconColor }}
              >
                {v.icon}
              </span>
              <span className="flex-1 text-left min-w-0 space-y-1">
                <span className="block text-base font-extrabold text-cafe">
                  {platform.name}
                  {platform.nameEn !== platform.name ? ` ${platform.nameEn}` : ''}
                </span>
                {platform.lastHeartbeat && (
                  <span className="block text-xs text-cafe-muted">{formatHeartbeat(platform.lastHeartbeat)}</span>
                )}
              </span>
              <span
                className={`shrink-0 rounded-xl px-2.5 py-1 text-xs font-semibold ${connStatePill(platform).className}`}
              >
                {connStatePill(platform).label}
              </span>
            </button>

            {/* F132 Phase E: WeCom Bot guided setup — dedicated panel with validate+connect */}
            {isExpanded && platform.id === 'wecom-bot' && (
              <div className="px-4 py-4 space-y-4">
                <div className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
                  <div className="console-code-pane space-y-3.5 px-4 py-4">
                    {guideSteps.map((step, idx) => (
                      <div key={idx} className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <StepBadge num={idx + 1} />
                          <span className="text-sm font-medium text-cafe">{step.text}</span>
                        </div>
                        {idx === 0 && (
                          <div className="ml-[26px]">
                            <a
                              href={platform.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="console-inline-link"
                            >
                              <ExternalLinkIcon />
                              <span>developer.work.weixin.qq.com → WeCom AI Bot docs</span>
                            </a>
                          </div>
                        )}
                        {idx === guideSteps.length - 1 && (
                          <div className="ml-[26px]">
                            <WeComBotSetupPanel
                              configured={platform.configured}
                              onConnected={() => void fetchStatus()}
                              onDisconnected={() => void fetchStatus()}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {PERMISSION_CONNECTORS[platform.id] && (
                  <Suspense fallback={<p className="text-xs text-cafe-muted">加载中...</p>}>
                    <HubPermissionsTab connectorId={platform.id} connectorLabel={PERMISSION_CONNECTORS[platform.id]} />
                  </Suspense>
                )}

                <ConnectorActionBar
                  platformId={platform.id}
                  saveResult={saveResult}
                  saving={saving}
                  onSave={() => handleSave(platform)}
                  testing={testing}
                  onTest={() => handleTest(platform)}
                />
              </div>
            )}

            {isExpanded && platform.id === 'weixin' && (
              <div className="console-code-pane space-y-3.5 px-4 py-4">
                {filteredSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-sm font-medium text-cafe">{step.text}</span>
                    </div>
                    {idx === 0 && (
                      <div className="ml-[26px]">
                        <div data-guide-id="connector.weixin.qr-panel">
                          <WeixinQrPanel configured={platform.configured} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isExpanded && platform.id !== 'weixin' && platform.id !== 'wecom-bot' && (
              <div className="px-4 py-4 space-y-4">
                <div className="console-list-card rounded-2xl overflow-hidden shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
                  <div className="bg-conn-sky-bg px-4 py-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-conn-sky-ring flex items-center justify-center text-conn-sky-text">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
                        />
                      </svg>
                    </div>
                    <div>
                      <div className="font-semibold text-sm">基础配置</div>
                      <div className="text-xs text-cafe-secondary">应用凭证与连接设置</div>
                    </div>
                  </div>
                  <div className="p-4 space-y-3.5">
                    {guideSteps.map((step, idx) => (
                      <div key={idx} className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <StepBadge num={idx + 1} />
                          <span className="text-sm font-medium text-cafe">{step.text}</span>
                        </div>
                        {idx === 0 && (
                          <div className="ml-[26px] space-y-2.5">
                            <a
                              href={platform.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="console-inline-link"
                            >
                              <ExternalLinkIcon />
                              <span>{new URL(platform.docsUrl).hostname} → 查看官方文档</span>
                            </a>
                            {platform.id === 'feishu' && (
                              <FeishuQrPanel
                                configured={platform.configured}
                                onConfirmed={() => void fetchStatus()}
                                onDisconnected={() => void fetchStatus()}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    ))}

                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <StepBadge num={guideSteps.length + 1} />
                        <span className="text-sm font-medium text-cafe">填写应用凭证</span>
                      </div>
                      <div className="ml-[26px] space-y-2.5">
                        {platform.fields.map((field) => (
                          <div key={field.envName}>
                            <label
                              htmlFor={`config-${field.envName}`}
                              className="block text-xs font-medium text-cafe-secondary mb-1"
                            >
                              {field.label}
                              {field.sensitive && (
                                <span className="text-conn-amber-text ml-1 inline-flex align-middle">
                                  <LockIcon />
                                </span>
                              )}
                            </label>
                            {field.envName === 'FEISHU_CONNECTION_MODE' ? (
                              <select
                                id={`config-${field.envName}`}
                                value={fieldValues[field.envName] ?? field.currentValue ?? 'webhook'}
                                onChange={(e) =>
                                  setFieldValues((prev) => ({ ...prev, [field.envName]: e.target.value }))
                                }
                                className="console-form-input py-2.5 text-sm"
                                data-testid={`field-${field.envName}`}
                              >
                                <option value="webhook">Webhook（需公网 URL）</option>
                                <option value="websocket">WebSocket 长连接（无需公网）</option>
                              </select>
                            ) : (
                              <input
                                id={`config-${field.envName}`}
                                type={field.sensitive ? 'password' : 'text'}
                                placeholder={
                                  field.sensitive
                                    ? field.currentValue
                                      ? '已设置（输入新值覆盖）'
                                      : '未设置'
                                    : (field.currentValue ?? '未设置')
                                }
                                value={fieldValues[field.envName] ?? ''}
                                onChange={(e) =>
                                  setFieldValues((prev) => ({ ...prev, [field.envName]: e.target.value }))
                                }
                                className="console-form-input py-2.5 text-sm"
                                data-testid={`field-${field.envName}`}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {PERMISSION_CONNECTORS[platform.id] && (
                  <Suspense fallback={<p className="text-xs text-cafe-muted">加载中...</p>}>
                    <HubPermissionsTab connectorId={platform.id} connectorLabel={PERMISSION_CONNECTORS[platform.id]} />
                  </Suspense>
                )}

                <ConnectorActionBar
                  platformId={platform.id}
                  saveResult={saveResult}
                  saving={saving}
                  onSave={() => handleSave(platform)}
                  testing={testing}
                  onTest={() => handleTest(platform)}
                />
              </div>
            )}
          </div>
        );
      })}

      <p className="text-xs text-cafe-muted">配置保存后自动生效，无需重启</p>
    </div>
  );
}
