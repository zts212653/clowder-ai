'use client';

import { useState } from 'react';
import { TagEditor } from './hub-tag-editor';
import type { ProfileProtocol } from './hub-provider-profiles.types';

export type ProviderFilterKey = 'all' | 'anthropic' | 'openai' | 'google' | 'api_key';

const FILTER_OPTIONS: Array<{ key: ProviderFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'anthropic', label: 'Claude' },
  { key: 'openai', label: 'Codex' },
  { key: 'google', label: 'Gemini' },
  { key: 'api_key', label: 'API Key' },
];

const PROTOCOL_OPTIONS: Array<{ value: ProfileProtocol; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI-Compatible' },
  { value: 'google', label: 'Gemini' },
];

export function formatProtocolLabel(protocol: ProfileProtocol): string {
  switch (protocol) {
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Gemini';
    default:
      return 'OpenAI-Compatible';
  }
}

export function inferProfileProtocol(baseUrl: string): ProfileProtocol {
  const normalized = baseUrl.trim().toLowerCase();
  if (normalized.includes('anthropic')) return 'anthropic';
  if (normalized.includes('googleapis.com') || normalized.includes('generativelanguage') || normalized.includes('gemini')) {
    return 'google';
  }
  return 'openai';
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
          className={`rounded-full px-3.5 py-2 text-sm font-semibold transition ${
            value === option.key
              ? 'bg-[#D49266] text-white'
              : 'bg-[#F7F3F0] text-[#8A776B] hover:bg-[#F0E7E0]'
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
        Claude / Codex / Gemini 三项内置 OAuth 不可新增或删除，仅可管理可用模型和激活状态；OpenCode / Dare 走
        OAuth-like 登录态，在 console 中统一按可复用账号看待，不再区分凭证来源；Antigravity 不在此页配置。
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
  busy,
  onDisplayNameChange,
  onProtocolChange,
  onBaseUrlChange,
  onApiKeyChange,
  onModelsChange,
  onCreate,
}: {
  displayName: string;
  protocol: ProfileProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
  busy: boolean;
  onDisplayNameChange: (value: string) => void;
  onProtocolChange: (value: ProfileProtocol) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelsChange: (value: string[]) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const inferredProtocol = inferProfileProtocol(baseUrl);

  return (
    <div className="rounded-[20px] border border-[#E8C9AF] bg-[#F7EEE6] p-[18px]">
      <button type="button" onClick={() => setOpen((value) => !value)} className="w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-base font-bold text-[#D49266]">+ 新建 API Key 账号</h4>
          <span className="text-xs font-semibold text-[#C8946B]">{open ? '收起' : '展开'}</span>
        </div>
      </button>
      <p className="mt-2 text-sm leading-6 text-[#8A776B]">
        仅支持新建 API Key 类型的账号配置。Claude / Codex / Gemini 三项内置 OAuth 订阅不可新增或删除，仅可管理可用模型和激活状态；OpenCode / Dare 走
        OAuth-like 登录态，console 里统一视作可复用账号能力。
      </p>
      {open ? (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input
              value={displayName}
              onChange={(e) => onDisplayNameChange(e.target.value)}
              placeholder="账号显示名（例如 my-glm）"
              className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm"
            />
            <select
              value={protocol}
              onChange={(e) => onProtocolChange(e.target.value as ProfileProtocol)}
              aria-label="Protocol"
              className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#5C4B42]"
            >
              {PROTOCOL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder="Base URL"
              className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
            />
            <div className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#8A776B] md:col-span-2">
              协议建议：{formatProtocolLabel(inferredProtocol)}
            </div>
            <input
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="API Key"
              className="rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm md:col-span-2"
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-[#5C4B42]">可用模型</p>
            <TagEditor
              tags={models}
              onChange={onModelsChange}
              addLabel="+ 添加"
              placeholder="输入模型名，例如 gpt-5.4"
              emptyLabel="(暂无模型)"
              tone="purple"
            />
          </div>
          <button
            type="button"
            onClick={onCreate}
            disabled={busy}
            className="rounded bg-[#D49266] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#c47f52] disabled:opacity-50"
          >
            {busy ? '创建中...' : '创建并激活'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
