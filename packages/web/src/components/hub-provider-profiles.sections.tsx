'use client';

import { useState } from 'react';
import { TagEditor } from './hub-tag-editor';

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
            className="rounded-full border border-[#E8DCCF] bg-white px-3 py-1.5 text-xs text-[#5C4B42]"
          >
            {allPaths.map((option) => (
              <option key={option.path} value={option.path}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <p className="mt-2 text-[13px] leading-6 text-[#8A776B]">每个账号可添加或删除模型。</p>
    </div>
  );
}

export type ApiProtocol = 'anthropic' | 'openai' | 'google';

const PROTOCOL_OPTIONS: Array<{ value: ApiProtocol; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
];

export function CreateApiKeyProfileSection({
  displayName,
  baseUrl,
  apiKey,
  protocol,
  models,
  busy,
  onDisplayNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onProtocolChange,
  onModelsChange,
  onCreate,
}: {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  protocol: ApiProtocol;
  models: string[];
  busy: boolean;
  onDisplayNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onProtocolChange: (protocol: ApiProtocol) => void;
  onModelsChange: (models: string[]) => void;
  onCreate: () => void;
}) {
  const canCreate = displayName.trim() && baseUrl.trim() && apiKey.trim() && models.length > 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-[20px] border border-[#E8C9AF] bg-[#F7EEE6] p-[18px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <h4 className="text-base font-bold text-[#D49266]">+ 新建 API Key 账号</h4>
        <span className="text-sm text-[#C8946B]">{expanded ? '▾ 收起' : '▸ 展开'}</span>
      </button>
      {expanded && (
        <div className="mt-4 space-y-3">
          <input
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="账号显示名，如 my-glm"
            className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
          />
          <select
            value={protocol}
            onChange={(e) => onProtocolChange(e.target.value as ApiProtocol)}
            className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm"
          >
            {PROTOCOL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            placeholder="API 服务地址，如 https://api.example.com/v1"
            className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
          />
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="sk-xxxxxxxxxxxxxxxx"
            className="w-full rounded border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
          />
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#8A776B]">可用模型 *</p>
            <TagEditor
              tags={models}
              tone="purple"
              addLabel="+ 添加模型"
              placeholder="输入模型名，如 gpt-4o"
              emptyLabel="(至少添加 1 个模型)"
              onChange={onModelsChange}
              minCount={0}
            />
          </div>
          <button
            type="button"
            onClick={onCreate}
            disabled={busy || !canCreate}
            className="rounded bg-[#D49266] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#c47f52] disabled:opacity-50"
          >
            {busy ? '创建中...' : '创建'}
          </button>
        </div>
      )}
    </div>
  );
}
