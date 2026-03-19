'use client';

import { useState } from 'react';
import type { ProfileProtocol } from './hub-provider-profiles.types';
import { TagEditor } from './hub-tag-editor';

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
  if (
    normalized.includes('googleapis.com') ||
    normalized.includes('generativelanguage') ||
    normalized.includes('gemini')
  ) {
    return 'google';
  }
  return 'openai';
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
  void projectLabel;

  return (
    <div className="rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-[#E29578]">系统配置 &gt; 账号配置</p>
        {allPaths.length > 1 ? (
          <select
            value={activePath ?? ''}
            onChange={(e) => onSwitchProject(e.target.value || null)}
            className="rounded-lg border border-[#E8DCCF] bg-white px-2.5 py-1.5 text-xs text-[#5C4B42]"
          >
            {allPaths.map((option) => (
              <option key={option.path} value={option.path}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
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
        </div>
      </button>
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
            {busy ? '创建中...' : '创建'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
