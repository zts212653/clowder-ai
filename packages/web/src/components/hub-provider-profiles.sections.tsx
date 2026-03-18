'use client';

import type { ProfileProtocol } from './hub-provider-profiles.types';

export type ProviderFilterKey = 'all' | 'claude-oauth' | 'codex-oauth' | 'gemini-oauth' | 'api_key';

const FILTER_OPTIONS: Array<{ key: ProviderFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'claude-oauth', label: 'Claude OAuth' },
  { key: 'codex-oauth', label: 'Codex OAuth' },
  { key: 'gemini-oauth', label: 'Gemini OAuth' },
  { key: 'api_key', label: 'API Key' },
];

export function parseModels(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatProtocolLabel(protocol: ProfileProtocol): string {
  switch (protocol) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
    case 'google':
      return 'Google';
    default:
      return protocol;
  }
}

export function ProviderFilterTabs({
  value,
  onChange,
}: {
  value: ProviderFilterKey;
  onChange: (next: ProviderFilterKey) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {FILTER_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
            value === option.key
              ? 'border-[#D49266] bg-[#FFF1E3] text-[#9A5A2C]'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ProviderProfilesSummaryCard({
  projectLabel,
  allPaths,
  activePath,
  onSwitchProject,
}: {
  projectLabel: string;
  allPaths: Array<{ path: string; label: string }>;
  activePath: string | null;
  onSwitchProject: (next: string | null) => void;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-gray-700">账号配置</h3>
        {allPaths.length > 1 ? (
          <select
            value={activePath ?? ''}
            onChange={(e) => onSwitchProject(e.target.value || null)}
            className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
          >
            {allPaths.map((option) => (
              <option key={option.path} value={option.path}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-gray-400">{projectLabel}</span>
        )}
      </div>
      <p className="text-xs text-gray-500">secrets 存储在 `.cat-cafe/provider-profiles.secrets.local.json`（本机落盘，Git 忽略）</p>
      <p className="mt-1 text-xs text-amber-700">
        3 个 OAuth provider 为内置账号，只能维护模型和激活状态；这里只新增 API Key 账号，浏览器 bridge 配置不在此页管理。
      </p>
    </div>
  );
}

export function CreateApiKeyProfileSection({
  displayName,
  protocol,
  baseUrl,
  apiKey,
  models,
  modelOverride,
  busy,
  onDisplayNameChange,
  onProtocolChange,
  onBaseUrlChange,
  onApiKeyChange,
  onModelsChange,
  onModelOverrideChange,
  onCreate,
}: {
  displayName: string;
  protocol: ProfileProtocol;
  baseUrl: string;
  apiKey: string;
  models: string;
  modelOverride: string;
  busy: boolean;
  onDisplayNameChange: (value: string) => void;
  onProtocolChange: (value: ProfileProtocol) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelsChange: (value: string) => void;
  onModelOverrideChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <h4 className="text-xs font-semibold text-gray-700">＋ 新建 API Key 账号</h4>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <input
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="账号显示名（例如 Codex Sponsor）"
          className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs"
        />
        <select
          value={protocol}
          onChange={(e) => onProtocolChange(e.target.value as ProfileProtocol)}
          className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs"
        >
          <option value="anthropic">{formatProtocolLabel('anthropic')}</option>
          <option value="openai">{formatProtocolLabel('openai')}</option>
          <option value="google">{formatProtocolLabel('google')}</option>
        </select>
        <input
          value={baseUrl}
          onChange={(e) => onBaseUrlChange(e.target.value)}
          placeholder="Base URL"
          className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs md:col-span-2"
        />
        <input
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder="API Key"
          className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs md:col-span-2"
        />
        <input
          value={models}
          onChange={(e) => onModelsChange(e.target.value)}
          placeholder="支持模型（逗号分隔）"
          className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs md:col-span-2"
        />
        <input
          value={modelOverride}
          onChange={(e) => onModelOverrideChange(e.target.value)}
          placeholder="默认/覆盖模型（可选）"
          className="rounded border border-gray-200 bg-white px-2 py-1.5 text-xs md:col-span-2"
        />
      </div>
      <button
        type="button"
        onClick={onCreate}
        disabled={busy}
        className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? '创建中...' : '创建并激活'}
      </button>
    </div>
  );
}
