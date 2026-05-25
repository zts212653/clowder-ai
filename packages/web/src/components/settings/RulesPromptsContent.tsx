'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsSection, SettingsText } from './primitives';
import {
  ConsumptionLegend,
  FILE_LABELS,
  type L0PromptsBlock,
  L0PromptsSection,
  type ProviderGuide,
  type RuleFile,
  RuleFileCard,
  shouldShowL0Section,
} from './RulesPromptsParts';

interface RulesData {
  sharedRules: RuleFile[];
  providerGuides: ProviderGuide[];
  l0Prompts?: L0PromptsBlock;
}

export type { L0PromptsBlock, PromptConsumptionInfo, RuleFile } from './RulesPromptsParts';
export { ConsumptionLegend, L0PromptsSection, RuleFileCard, shouldShowL0Section } from './RulesPromptsParts';

const PROVIDER_LABELS: Record<string, string> = {
  claude: '布偶猫 (Claude)',
  codex: '缅因猫 (Codex)',
  gemini: '暹罗猫 (Gemini)',
};

export function RulesPromptsContent() {
  const [data, setData] = useState<RulesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ file: RuleFile; label: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/rules');
        if (cancelled) return;
        if (!res.ok) {
          setError('规则加载失败');
          return;
        }
        setData((await res.json()) as RulesData);
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <SettingsText as="p" variant="sm" tone="red">
        {error}
      </SettingsText>
    );
  }
  if (!data)
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        加载中...
      </SettingsText>
    );

  const visibleL0Prompts = data.l0Prompts && shouldShowL0Section(data.l0Prompts) ? data.l0Prompts : undefined;

  return (
    <div className="space-y-6">
      <ConsumptionLegend />
      <SettingsSection
        title="共享规则"
        description="显示规则文件的真实消费方式：shared-rules.md 会编译进 governance L0；SOP.md 是参考文档。"
        badge={<SettingsBadge tone="slate">{data.sharedRules.length} files</SettingsBadge>}
      >
        <div className="space-y-3">
          {data.sharedRules.map((file) => (
            <RuleFileCard
              key={file.path}
              file={file}
              onClick={() => setPreviewFile({ file, label: FILE_LABELS[file.path] ?? file.path })}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="模型指南"
        description="每只猫的角色定义和模型特定约束"
        badge={<SettingsBadge tone="slate">{data.providerGuides.length} guides</SettingsBadge>}
      >
        <div className="space-y-3">
          {data.providerGuides.map((guide) => (
            <RuleFileCard
              key={guide.path}
              file={guide}
              label={PROVIDER_LABELS[guide.provider]}
              onClick={() => setPreviewFile({ file: guide, label: PROVIDER_LABELS[guide.provider] ?? guide.path })}
            />
          ))}
        </div>
      </SettingsSection>

      {visibleL0Prompts && (
        <L0PromptsSection l0Prompts={visibleL0Prompts} onPreview={(file, label) => setPreviewFile({ file, label })} />
      )}

      {previewFile && (
        <RulePreviewModal label={previewFile.label} file={previewFile.file} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}

function RulePreviewModal({ label, file, onClose }: { label: string; file: RuleFile; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const lineCount = file.content.split('\n').length;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm"
      style={{ backgroundColor: 'var(--console-overlay-backdrop)', padding: '1rem' }}
    >
      <button type="button" aria-label="关闭预览" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[calc(100vh-32px)] w-full max-w-[620px] flex-col overflow-hidden"
        style={{
          borderRadius: '1rem',
          backgroundColor: 'var(--console-card-bg)',
          padding: '26px',
          boxShadow: '0 20px 48px rgba(43,33,26,0.14)',
        }}
      >
        <div className="flex shrink-0 items-center gap-[14px]">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center font-bold"
            style={{
              borderRadius: '0.75rem',
              backgroundColor: 'var(--console-active-bg)',
              fontSize: 'var(--console-font-lg)',
              color: 'var(--console-modal-title)',
            }}
          >
            📜
          </div>
          <div className="min-w-0 flex-1">
            <SettingsText
              as="h2"
              variant="base"
              tone="default"
              className="font-bold"
              style={{ fontSize: 'var(--console-font-xl)' }}
            >
              {label}
            </SettingsText>
            <SettingsText as="p" tone="muted">
              {file.path} · {lineCount} 行
            </SettingsText>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center transition"
            style={{
              borderRadius: '0.75rem',
              fontSize: 'var(--console-font-base)',
              color: 'var(--cafe-text-muted)',
            }}
          >
            ✕
          </button>
        </div>

        <div
          className="mt-4 min-h-0 flex-1 overflow-y-auto"
          style={{ borderRadius: '1rem', backgroundColor: 'var(--console-panel-bg)', padding: '1rem' }}
        >
          <pre
            className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono leading-6"
            style={{ fontSize: 'var(--console-font-xs)', color: 'var(--cafe-text-secondary)' }}
          >
            {file.content}
          </pre>
        </div>
      </div>
    </div>
  );
}
