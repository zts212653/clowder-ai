'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { FeishuQrPanel } from './FeishuQrPanel';
import { DEFAULT_VISUAL, ExternalLinkIcon, LockIcon, PLATFORM_VISUALS, StepBadge, WifiIcon } from './HubConfigIcons';
import type { HubPermissionsTabHandle } from './HubPermissionsTab';
import { SettingsPageHeader } from './settings/SettingsPageHeader';
import type { WeComBotSetupPanelHandle } from './WeComBotSetupPanel';
import { WeComBotSetupPanel } from './WeComBotSetupPanel';
import { WeixinQrPanel } from './WeixinQrPanel';

const HubPermissionsTab = lazy(() => import('./HubPermissionsTab'));

const PERMISSION_CONNECTORS: Record<string, string> = {
  feishu: '飞书',
  'wecom-bot': '企业微信',
  dingtalk: '钉钉',
};

interface PlatformFieldStatus {
  envName: string;
  label: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface PlatformStepStatus {
  text: string;
  mode?: string;
}

interface PlatformStatus {
  id: string;
  name: string;
  nameEn: string;
  category?: 'im' | 'plugin';
  configured: boolean;
  connectionState?: 'connected' | 'disconnected' | 'reconnecting' | 'unknown';
  lastHeartbeat?: number | null;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: PlatformStepStatus[];
}

function connStatePill(p: PlatformStatus): { label: string; className: string } {
  if (p.connectionState === 'connected')
    return { label: '已连接', className: 'bg-conn-emerald-bg text-conn-emerald-text' };
  if (p.connectionState === 'reconnecting')
    return { label: '重连中', className: 'bg-conn-amber-bg text-conn-amber-text' };
  if (p.connectionState === 'disconnected' && p.configured)
    return { label: '已配置', className: 'bg-conn-amber-bg text-conn-amber-text' };
  if (p.configured) return { label: '已配置', className: 'bg-conn-amber-bg text-conn-amber-text' };
  return { label: '未配置', className: 'bg-cafe-surface-sunken text-cafe-muted' };
}

function formatHeartbeat(ts: number): string {
  const ago = Math.floor((Date.now() - ts) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  return `${Math.floor(ago / 3600)}h ago`;
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
  const permissionsRef = useRef<HubPermissionsTabHandle>(null);
  const wecomRef = useRef<WeComBotSetupPanelHandle>(null);

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
    setSaving(true);
    setSaveResult(null);

    if (platform.id === 'wecom-bot' && wecomRef.current?.hasPendingCredentials()) {
      const ok = await wecomRef.current.validate();
      if (!ok) {
        setSaving(false);
        return;
      }
    }

    const secrets = platform.fields
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] || null }));

    const rawPerms = permissionsRef.current?.getConfig();

    try {
      const res = await apiFetch(`/api/connector/${platform.id}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(secrets.length > 0 ? { secrets } : {}),
          ...(rawPerms ? { permissions: rawPerms } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveResult({ type: 'error', message: data.error ?? '保存失败' });
      } else {
        const data = await res.json().catch(() => ({}));
        if (secrets.length > 0) {
          setFieldValues({});
          await fetchStatus();
        }
        if (data.permissions && permissionsRef.current) {
          permissionsRef.current.applyConfig(data.permissions);
        }
        setSaveResult({ type: 'success', message: '配置已保存，连接器正在自动重连...' });
      }
    } catch {
      setSaveResult({ type: 'error', message: '保存网络错误' });
    }
    setSaving(false);
  };

  const handleTestConnection = async (platformId: string) => {
    setTesting(true);
    setSaveResult(null);
    try {
      const res = await apiFetch(`/api/connector/${platformId}/test`, { method: 'POST' });
      const data = await res.json();
      setSaveResult({
        type: data.ok ? 'success' : 'error',
        message: data.message ?? (data.ok ? '连接正常' : (data.error ?? '测试失败')),
      });
      await fetchStatus();
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
      <SettingsPageHeader title="IM 对接" subtitle="连接状态与回调配置" />

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
                className="flex h-11 w-11 items-center justify-center rounded-[12px] shrink-0"
                style={{ backgroundColor: v.iconBg, color: v.iconColor }}
              >
                {v.icon}
              </span>
              <span className="flex-1 text-left min-w-0 space-y-1">
                <span className="block text-[15px] font-extrabold text-cafe">
                  {platform.name}
                  {platform.nameEn !== platform.name ? ` ${platform.nameEn}` : ''}
                </span>
                {platform.lastHeartbeat && (
                  <span className="block text-[11px] text-cafe-muted">{formatHeartbeat(platform.lastHeartbeat)}</span>
                )}
              </span>
              <span
                className={`shrink-0 rounded-[13px] px-2.5 py-1 text-xs font-semibold ${connStatePill(platform).className}`}
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
                          <span className="text-[13px] font-medium text-cafe">{step.text}</span>
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
                              ref={wecomRef}
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
                    <HubPermissionsTab ref={permissionsRef} connectorId={platform.id} />
                  </Suspense>
                )}

                {saveResult && (
                  <div
                    className={`rounded-[16px] px-3 py-2 text-xs ${
                      saveResult.type === 'success'
                        ? 'bg-conn-emerald-bg text-conn-emerald-text border border-conn-emerald-ring'
                        : 'bg-conn-red-bg text-conn-red-text border border-conn-red-ring'
                    }`}
                  >
                    {saveResult.message}
                  </div>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="console-button-secondary text-[13px]"
                    disabled={testing}
                    onClick={() => handleTestConnection(platform.id)}
                  >
                    <WifiIcon />
                    {testing ? '测试中...' : '测试连接'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSave(platform)}
                    disabled={saving}
                    className="console-button-primary text-[13px] disabled:opacity-50"
                  >
                    {saving ? '保存中...' : '保存配置'}
                  </button>
                </div>
              </div>
            )}

            {isExpanded && platform.id === 'weixin' && (
              <div className="console-code-pane space-y-3.5 px-4 py-4">
                {filteredSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-[13px] font-medium text-cafe">{step.text}</span>
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
                          <span className="text-[13px] font-medium text-cafe">{step.text}</span>
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
                        <span className="text-[13px] font-medium text-cafe">填写应用凭证</span>
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
                                className="console-form-input py-2.5 text-[13px]"
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
                                className="console-form-input py-2.5 text-[13px]"
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
                    <HubPermissionsTab ref={permissionsRef} connectorId={platform.id} />
                  </Suspense>
                )}

                {saveResult && (
                  <div
                    className={`rounded-[16px] px-3 py-2 text-xs ${
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
                    className="console-button-secondary text-[13px]"
                    disabled={testing}
                    onClick={() => handleTestConnection(platform.id)}
                  >
                    <WifiIcon />
                    {testing ? '测试中...' : '测试连接'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSave(platform)}
                    disabled={saving}
                    className="console-button-primary text-[13px] disabled:opacity-50"
                    data-testid={`save-${platform.id}`}
                  >
                    {saving ? '保存中...' : '保存配置'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <p className="text-xs text-cafe-muted">配置保存后需重启连接器生效。</p>
    </div>
  );
}
