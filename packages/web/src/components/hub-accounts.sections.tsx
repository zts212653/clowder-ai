'use client';

import { useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { TagEditor } from './hub-tag-editor';

export function AccountsSummaryCard() {
  return (
    <div className="rounded-2xl bg-[var(--console-card-bg)] p-[18px]">
      <p className="text-sm font-semibold text-cafe-accent">系统配置 &gt; 账号配置</p>
      <p className="mt-2 text-sm leading-6 text-cafe-muted">
        每个账号可添加或删除模型。账号配置全局共享，所有项目通用。
      </p>
    </div>
  );
}

export function CreateApiKeyAccountSection({
  displayName,
  baseUrl,
  apiKey,
  models,
  busy,
  onDisplayNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onModelsChange,
  onCreate,
}: {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  busy: boolean;
  onDisplayNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelsChange: (models: string[]) => void;
  onCreate: () => void;
}) {
  const activeGuideStep = useGuideStore((s) => {
    const session = s.session;
    if (!session || session.currentStepIndex >= session.flow.steps.length) return null;
    return session.flow.steps[session.currentStepIndex];
  });
  const canCreate = displayName.trim() && baseUrl.trim() && apiKey.trim() && models.length > 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-2xl bg-[var(--console-card-soft-bg)] p-[18px]">
      <button
        type="button"
        onClick={() =>
          setExpanded((prev) => {
            const isGuideLockedToggle =
              prev && activeGuideStep?.advance === 'click' && activeGuideStep.target === 'accounts.create-form';
            if (isGuideLockedToggle) return prev;
            return !prev;
          })
        }
        className="flex w-full items-center justify-between text-left"
        data-guide-id="accounts.create-form"
      >
        <h4 className="text-base font-bold text-cafe-accent">+ 新建 API Key 账号</h4>
        <span className="text-sm text-cafe-accent/70">{expanded ? '▾ 收起' : '▸ 展开'}</span>
      </button>
      {expanded && (
        <div className="mt-4 space-y-3" data-guide-id="accounts.create-details">
          <input
            value={displayName}
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="账号显示名，如 my-glm"
            className="w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2 text-sm placeholder:text-cafe-muted"
          />
          <input
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            placeholder="API 服务地址，如 https://api.example.com/v1"
            className="w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2 text-sm placeholder:text-cafe-muted"
          />
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder="sk-xxxxxxxxxxxxxxxx"
            className="w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2 text-sm placeholder:text-cafe-muted"
            data-guide-id="accounts.api-key"
          />
          <div className="space-y-2">
            <p className="text-xs font-semibold text-cafe-muted">可用模型 *</p>
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
            className="rounded bg-cafe-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-cafe-accent-hover disabled:opacity-50"
            data-guide-id="accounts.create-submit"
          >
            {busy ? '创建中...' : '创建'}
          </button>
        </div>
      )}
    </div>
  );
}
