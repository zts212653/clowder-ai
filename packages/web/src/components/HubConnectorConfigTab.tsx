'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { ConnectorActionBar } from './ConnectorActionBar';
import {
  buildPlatformVisual,
  connStatePill,
  ExternalLinkIcon,
  formatHeartbeat,
  type PlatformStatus,
  StepBadge,
  TrashIcon,
} from './HubConfigIcons';
import { settingsResourceCardClass } from './SettingsResourceCard';
import { ActionRenderer } from './settings/primitives/ActionRenderer';
import { ConfigFieldRenderer } from './settings/primitives/ConfigFieldRenderer';

const HubPermissionsTab = lazy(() => import('./HubPermissionsTab'));

const REDACTED_PLACEHOLDER = '••••••';
type SaveResult = { type: 'success' | 'error'; message: string };

export function HubConnectorConfigTab({ refreshKey }: { refreshKey?: number }) {
  const activeGuideStep = useGuideStore((s) => {
    const session = s.session;
    if (!session || session.currentStepIndex >= session.flow.steps.length) return null;
    return session.flow.steps[session.currentStepIndex];
  });
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [savingById, setSavingById] = useState<Record<string, boolean>>({});
  const [testingById, setTestingById] = useState<Record<string, boolean>>({});
  const [saveResultsById, setSaveResultsById] = useState<Record<string, SaveResult | undefined>>({});
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const expandedIdRef = useRef<string | null>(null);

  useEffect(() => {
    expandedIdRef.current = expandedId;
  }, [expandedId]);

  const clearSaveResult = (platformId: string) => {
    setSaveResultsById((prev) => {
      const next = { ...prev };
      delete next[platformId];
      return next;
    });
  };

  const setSavingFor = (platformId: string, active: boolean) => {
    setSavingById((prev) => {
      const next = { ...prev };
      if (active) next[platformId] = true;
      else delete next[platformId];
      return next;
    });
  };

  const setTestingFor = (platformId: string, active: boolean) => {
    setTestingById((prev) => {
      const next = { ...prev };
      if (active) next[platformId] = true;
      else delete next[platformId];
      return next;
    });
  };

  const setSaveResultFor = (platformId: string, result: SaveResult) => {
    setSaveResultsById((prev) => ({ ...prev, [platformId]: result }));
  };

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = await res.json();
      const all: PlatformStatus[] = data.platforms ?? [];
      setPlatforms(all);
    } catch {
      // fall through
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleUninstallPlugin = useCallback(
    async (id: string) => {
      if (!window.confirm(`确定要卸载插件 ${id} 吗？`)) return;
      setUninstallingId(id);
      try {
        const res = await apiFetch(`/api/connectors/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (res.ok) {
          await fetchStatus();
        }
      } catch {
        // silent
      } finally {
        setUninstallingId(null);
      }
    },
    [fetchStatus],
  );

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, refreshKey]);

  const handleExpand = (platformId: string) => {
    const guideToggleTarget = `connector.${platformId}`;
    if (expandedId === platformId) {
      if (activeGuideStep?.advance === 'click' && activeGuideStep.target === guideToggleTarget) {
        return;
      }
      setExpandedId(null);
      setFieldValues({});
      clearSaveResult(platformId);
      return;
    }
    setExpandedId(platformId);
    setFieldValues({});
    clearSaveResult(platformId);
  };

  const handleSave = async (platform: PlatformStatus) => {
    // F240: save to .cat-cafe config store via PUT /api/connectors/:id/config (not legacy /api/config/secrets)
    const fields = platform.fields
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] || null }));

    if (fields.length === 0) {
      setSaveResultFor(platform.id, { type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    if (fields.some((f) => f.value?.includes(REDACTED_PLACEHOLDER))) {
      setSaveResultFor(platform.id, { type: 'error', message: '不能保存脱敏占位符，请输入新的完整凭据' });
      return;
    }

    setSavingFor(platform.id, true);
    clearSaveResult(platform.id);
    try {
      const res = await apiFetch(`/api/connectors/${encodeURIComponent(platform.id)}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveResultFor(platform.id, { type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setSaveResultFor(platform.id, { type: 'success', message: '配置已保存，连接器正在自动重连...' });
      if (expandedIdRef.current === platform.id) setFieldValues({});
      await fetchStatus();
    } catch {
      setSaveResultFor(platform.id, { type: 'error', message: '网络错误' });
    } finally {
      setSavingFor(platform.id, false);
    }
  };

  const handleTest = async (platform: PlatformStatus) => {
    setTestingFor(platform.id, true);
    clearSaveResult(platform.id);
    try {
      const res = await apiFetch(`/api/connector/${encodeURIComponent(platform.id)}/test`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as { valid?: boolean; error?: string };
      if (data.valid) {
        setSaveResultFor(platform.id, { type: 'success', message: '连接正常' });
      } else {
        setSaveResultFor(platform.id, { type: 'error', message: data.error || '连接失败' });
      }
    } catch {
      setSaveResultFor(platform.id, { type: 'error', message: '网络错误' });
    } finally {
      setTestingFor(platform.id, false);
    }
  };

  if (isLoading) {
    return <p className="text-center text-cafe-muted py-8 text-sm">加载中...</p>;
  }

  if (platforms.length === 0) {
    return <p className="text-center text-cafe-muted py-8 text-sm">无法加载平台配置信息</p>;
  }

  return (
    <div className="space-y-3">
      {platforms.map((platform) => {
        const isExpanded = expandedId === platform.id;
        const v = buildPlatformVisual(platform);
        // Generic mode-driver: find select field whose options match step mode values
        const stepModes = new Set(platform.steps.filter((s) => s.mode).map((s) => s.mode));
        const modeField =
          stepModes.size > 0
            ? platform.fields.find((f) => f.type === 'select' && f.options?.some((o) => stepModes.has(o.value)))
            : undefined;
        const selectedMode = modeField
          ? (fieldValues[modeField.envName] ?? modeField.currentValue ?? modeField.options?.[0]?.value)
          : undefined;
        const filteredSteps = platform.steps.filter((s) => !s.mode || s.mode === selectedMode);
        const guideSteps = filteredSteps.slice(0, -1);

        return (
          <div
            key={platform.id}
            className="console-list-card rounded-xl overflow-hidden shadow-[var(--console-shadow-soft)] hover:shadow-md"
            data-testid={`platform-card-${platform.id}`}
            data-guide-id={`connector.${platform.id}`}
            data-active={isExpanded ? 'true' : 'false'}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => handleExpand(platform.id)}
              onKeyDown={(e) => e.key === 'Enter' && handleExpand(platform.id)}
              className="flex w-full items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
            >
              <span
                className="flex h-9 w-9 items-center justify-center rounded-xl shrink-0 overflow-hidden"
                style={{ backgroundColor: v.iconBg, color: v.iconColor }}
              >
                {v.icon}
              </span>
              <span className="flex-1 text-left min-w-0 space-y-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-cafe">
                  {platform.name}
                  {platform.nameEn !== platform.name ? ` ${platform.nameEn}` : ''}
                  {platform.source === 'external' && (
                    <span className="rounded bg-cafe-surface-sunken px-1.5 py-0.5 text-micro font-medium text-cafe-muted">
                      外部
                    </span>
                  )}
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
              {platform.source === 'external' && (
                <button
                  type="button"
                  disabled={uninstallingId === platform.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUninstallPlugin(platform.id);
                  }}
                  className="shrink-0 rounded-lg p-1.5 text-cafe-muted transition-colors hover:bg-conn-red-bg hover:text-conn-red-text disabled:opacity-50"
                  title="卸载插件"
                >
                  <TrashIcon />
                </button>
              )}
            </div>

            {isExpanded && (
              <div className="px-4 py-4 space-y-4">
                <div className={`${settingsResourceCardClass} overflow-hidden`}>
                  {/* Section header — themed from manifest */}
                  <div className="px-4 py-3 flex items-center gap-3" style={{ backgroundColor: v.iconBg }}>
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center overflow-hidden"
                      style={{ color: v.iconColor }}
                    >
                      {v.icon}
                    </div>
                    <div>
                      <div className="font-semibold text-sm">基础配置</div>
                      <div className="text-xs text-cafe-secondary">应用凭证与连接设置</div>
                    </div>
                  </div>

                  <div className="p-4 space-y-3.5">
                    {/* Guide steps from manifest */}
                    {guideSteps.map((step, idx) => (
                      <div key={step.text} className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <StepBadge num={idx + 1} />
                          <span className="text-sm font-medium text-cafe">{step.text}</span>
                        </div>
                        {idx === 0 && (
                          <div className="ml-[26px] space-y-2.5">
                            {platform.docsUrl && URL.canParse(platform.docsUrl) && (
                              <a
                                href={platform.docsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="console-inline-link"
                              >
                                <ExternalLinkIcon />
                                <span>{new URL(platform.docsUrl).hostname} → 查看官方文档</span>
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Operations (ActionRenderer) — from YAML manifest */}
                    {platform.operations && platform.operations.length > 0 && (
                      <div className="ml-[26px] space-y-2.5">
                        {platform.operations.map((op) => (
                          <ActionRenderer
                            key={op.name}
                            connectorId={platform.id}
                            operation={op}
                            configured={platform.configured}
                            pendingConfigValues={fieldValues}
                            onStatusChange={() => void fetchStatus()}
                            themeColor={platform.themeColor}
                          />
                        ))}
                      </div>
                    )}

                    {/* Config fields (ConfigFieldRenderer) — from YAML manifest */}
                    {platform.fields.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5">
                          <StepBadge num={guideSteps.length + 1} />
                          <span className="text-sm font-medium text-cafe">填写应用凭证</span>
                        </div>
                        <div className="ml-[26px] space-y-2.5">
                          {platform.fields.map((field) => (
                            <ConfigFieldRenderer
                              key={field.envName}
                              field={field}
                              value={fieldValues[field.envName] ?? ''}
                              onChange={(envName, val) => setFieldValues((prev) => ({ ...prev, [envName]: val }))}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {platform.permissionLabel && (
                  <Suspense fallback={<p className="text-xs text-cafe-muted">加载中...</p>}>
                    <HubPermissionsTab connectorId={platform.id} connectorLabel={platform.permissionLabel} />
                  </Suspense>
                )}

                <ConnectorActionBar
                  platformId={platform.id}
                  saveResult={saveResultsById[platform.id] ?? null}
                  saving={savingById[platform.id] === true}
                  onSave={() => handleSave(platform)}
                  showTest={platform.testable === true}
                  testing={testingById[platform.id] === true}
                  onTest={() => handleTest(platform)}
                />
              </div>
            )}
          </div>
        );
      })}

      <p className="mt-4 text-xs text-cafe-muted">配置保存后自动生效，无需重启</p>
    </div>
  );
}
