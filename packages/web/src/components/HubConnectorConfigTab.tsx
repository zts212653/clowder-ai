'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  ChevronDown,
  ChevronRight,
  DEFAULT_VISUAL,
  ExternalLinkIcon,
  LockIcon,
  PLATFORM_VISUALS,
  StatusDotConnected,
  StatusDotIdle,
  StepBadge,
  TriangleAlertIcon,
  WifiIcon,
} from './HubConfigIcons';
import { WeixinQrPanel } from './WeixinQrPanel';

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
  configured: boolean;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: PlatformStepStatus[];
}

export function HubConnectorConfigTab() {
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = await res.json();
      setPlatforms(data.platforms ?? []);
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
    if (expandedId === platformId) {
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
    // Sensitive fields must be set in .env manually — only non-sensitive can be patched
    const updates = platform.fields
      .filter((f) => !f.sensitive && fieldValues[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] }));

    if (updates.length === 0) {
      setSaveResult({ type: 'error', message: '请填写至少一个非敏感配置项（敏感字段需手动编辑 .env）' });
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch('/api/config/env', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveResult({ type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setSaveResult({ type: 'success', message: '配置已保存。需重启 API 服务使连接器生效。' });
      setFieldValues({});
      await fetchStatus();
    } catch {
      setSaveResult({ type: 'error', message: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <p className="text-center text-gray-400 py-8 text-sm">加载中...</p>;
  }

  if (platforms.length === 0) {
    return <p className="text-center text-gray-400 py-8 text-sm">无法加载平台配置信息</p>;
  }

  return (
    <div className="space-y-3">
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
            className="border border-gray-200 rounded-2xl overflow-hidden"
            data-testid={`platform-card-${platform.id}`}
          >
            <button
              type="button"
              onClick={() => handleExpand(platform.id)}
              className={`w-full flex items-center gap-3 px-4 py-3.5 transition-colors ${isExpanded ? 'bg-sky-50' : 'hover:bg-gray-50'}`}
            >
              <span
                className="flex items-center justify-center w-9 h-9 rounded-[10px] shrink-0"
                style={{ backgroundColor: v.iconBg, color: v.iconColor }}
              >
                {v.icon}
              </span>
              <span className="flex-1 text-left min-w-0">
                <span className="block text-[15px] font-semibold text-gray-900">
                  {platform.name} {platform.nameEn !== platform.name ? platform.nameEn : ''}
                </span>
                <span
                  className={`flex items-center gap-1 text-xs ${platform.configured ? 'text-green-600' : 'text-gray-400'}`}
                >
                  {platform.configured ? <StatusDotConnected /> : <StatusDotIdle />}
                  {platform.configured ? '已配置' : '未配置'}
                </span>
              </span>
              <span className="text-gray-400 shrink-0">{isExpanded ? <ChevronDown /> : <ChevronRight />}</span>
            </button>

            {isExpanded && platform.id === 'weixin' && (
              <div className="border-t border-gray-100 px-4 py-4 space-y-3.5">
                {filteredSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-[13px] font-medium text-gray-900">{step.text}</span>
                    </div>
                    {idx === 0 && (
                      <div className="ml-[26px]">
                        <WeixinQrPanel configured={platform.configured} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isExpanded && platform.id !== 'weixin' && (
              <div className="border-t border-gray-100 px-4 py-4 space-y-3.5">
                {guideSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-[13px] font-medium text-gray-900">{step.text}</span>
                    </div>
                    {idx === 0 && (
                      <a
                        href={platform.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-blue-600 bg-sky-50 rounded-lg px-3 py-2 hover:bg-sky-100 transition-colors ml-[26px]"
                      >
                        <ExternalLinkIcon />
                        <span>{new URL(platform.docsUrl).hostname} → 查看官方文档</span>
                      </a>
                    )}
                  </div>
                ))}

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <StepBadge num={guideSteps.length + 1} />
                    <span className="text-[13px] font-medium text-gray-900">填写应用凭证</span>
                  </div>
                  <div className="ml-[26px] space-y-2.5">
                    {platform.fields.map((field) => (
                      <div key={field.envName}>
                        <label
                          htmlFor={`config-${field.envName}`}
                          className="block text-xs font-medium text-gray-500 mb-1"
                        >
                          {field.label}
                          {field.sensitive && (
                            <span className="text-amber-500 ml-1 inline-flex align-middle">
                              <LockIcon />
                            </span>
                          )}
                        </label>
                        {field.sensitive ? (
                          <div className="w-full h-9 flex items-center px-3 text-[13px] bg-gray-50 border border-gray-200 rounded-lg text-gray-400">
                            {field.currentValue ?? '••••••••••••••••'}
                            <span className="ml-auto text-[10px] text-amber-600 whitespace-nowrap">编辑 .env</span>
                          </div>
                        ) : field.envName === 'FEISHU_CONNECTION_MODE' ? (
                          <select
                            id={`config-${field.envName}`}
                            value={fieldValues[field.envName] ?? field.currentValue ?? 'webhook'}
                            onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
                            className="w-full h-9 px-3 text-[13px] bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors"
                            data-testid={`field-${field.envName}`}
                          >
                            <option value="webhook">Webhook（需公网 URL）</option>
                            <option value="websocket">WebSocket 长连接（无需公网）</option>
                          </select>
                        ) : (
                          <input
                            id={`config-${field.envName}`}
                            type="text"
                            placeholder={field.currentValue ?? '未设置'}
                            value={fieldValues[field.envName] ?? ''}
                            onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
                            className="w-full h-9 px-3 text-[13px] bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors"
                            data-testid={`field-${field.envName}`}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <StepBadge num={filteredSteps.length} />
                    <span className="text-[13px] font-medium text-gray-900">测试连接并保存</span>
                  </div>
                  {saveResult && (
                    <div
                      className={`text-xs px-3 py-2 rounded-lg ml-[26px] ${
                        saveResult.type === 'success'
                          ? 'bg-green-50 text-green-700 border border-green-200'
                          : 'bg-red-50 text-red-700 border border-red-200'
                      }`}
                      data-testid="save-result"
                    >
                      {saveResult.message}
                    </div>
                  )}
                  <div className="flex items-center gap-2 ml-[26px]">
                    <button
                      type="button"
                      className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                      onClick={() => setSaveResult({ type: 'success', message: '连接测试功能即将上线' })}
                    >
                      <WifiIcon />
                      测试连接
                    </button>
                    {platform.fields.some((f) => !f.sensitive) ? (
                      <button
                        type="button"
                        onClick={() => handleSave(platform)}
                        disabled={saving}
                        className="px-4 py-2 text-[13px] font-semibold text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50"
                        data-testid={`save-${platform.id}`}
                      >
                        {saving ? '保存中...' : '保存配置'}
                      </button>
                    ) : (
                      <div className="flex-1 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-700">
                        <p className="font-medium flex items-center gap-1">
                          <LockIcon /> 所有凭证为敏感字段，请手动配置：
                        </p>
                        <code className="block mt-1 text-[11px] bg-amber-100 rounded px-2 py-1 font-mono select-all">
                          {platform.fields.map((f) => `${f.envName}=your_value`).join('\n')}
                        </code>
                        <p className="mt-1 text-[11px]">写入 .env 文件后重启 API 服务生效</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-2 bg-amber-50 border border-yellow-300 rounded-[10px] px-3.5 py-2.5">
        <TriangleAlertIcon />
        <span className="text-xs font-medium text-amber-800">修改配置后需重启 API 生效</span>
      </div>
    </div>
  );
}
