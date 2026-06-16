'use client';

/**
 * Rules & Injection section — two sub-tabs:
 *   1. "生命周期与注入" — lifecycle pipeline + injection segments + compiled sources
 *   2. "Agent 规则" — reference docs (SOP) + model guides
 *
 * Data split by consumption.kind:
 *   actual-prompt / harness-injected → Tab 1 (compiled into prompt)
 *   reference / skill-on-demand → Tab 2 (agent loads on demand)
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { InjectionManifestContent } from './InjectionManifestContent';
import { SettingsBadge, SettingsSection, SettingsText } from './primitives';
import {
  FILE_LABELS,
  type L0PromptsBlock,
  L0PromptsSection,
  type ProviderGuide,
  type RuleFile,
  RuleFileCard,
  shouldShowL0Section,
} from './RulesPromptsParts';

export type { L0PromptsBlock, PromptConsumptionInfo, RuleFile } from './RulesPromptsParts';
export { L0PromptsSection, RuleFileCard, shouldShowL0Section } from './RulesPromptsParts';

// ── Tab types ─────────────────────────────────────────────────

type RulesTab = 'lifecycle' | 'agent-rules';

const TABS: readonly { id: RulesTab; label: string }[] = [
  { id: 'lifecycle', label: '生命周期与注入' },
  { id: 'agent-rules', label: 'Agent 规则' },
] as const;

// ── Rules data ────────────────────────────────────────────────

interface RulesData {
  sharedRules: RuleFile[];
  providerGuides: ProviderGuide[];
  l0Prompts?: L0PromptsBlock;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: '布偶猫 (Claude)',
  codex: '缅因猫 (Codex)',
  gemini: '暹罗猫 (Gemini)',
};

// ── Main component ────────────────────────────────────────────

export function RulesPromptsContent() {
  const [activeTab, setActiveTab] = useState<RulesTab>('lifecycle');
  const [rulesData, setRulesData] = useState<RulesData | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ file: RuleFile; label: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/rules');
        if (cancelled) return;
        if (!res.ok) {
          setRulesError('规则加载失败');
          return;
        }
        setRulesData((await res.json()) as RulesData);
      } catch {
        if (!cancelled) setRulesError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <nav aria-label="Rules navigation" className="flex console-divider-b">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              className={`inline-flex items-center px-5 py-2.5 text-sm font-semibold transition-colors ${
                isActive
                  ? 'border-b-2 border-[var(--console-button-emphasis)] text-[var(--console-button-emphasis)]'
                  : 'text-cafe-muted hover:text-cafe-secondary'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Tab content */}
      {activeTab === 'lifecycle' && (
        <LifecycleTabContent rulesData={rulesData} rulesError={rulesError} onPreview={setPreviewFile} />
      )}
      {activeTab === 'agent-rules' && (
        <AgentRulesTabContent rulesData={rulesData} rulesError={rulesError} onPreview={setPreviewFile} />
      )}

      {/* Shared preview modal */}
      {previewFile && (
        <RulePreviewModal label={previewFile.label} file={previewFile.file} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}

// ── Tab 1: Lifecycle & Injections ────────────────────────────

function LifecycleTabContent({
  rulesData,
  rulesError,
  onPreview,
}: {
  rulesData: RulesData | null;
  rulesError: string | null;
  onPreview: (p: { file: RuleFile; label: string }) => void;
}) {
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);

  const handleStageChange = useCallback((stageId: string | null) => {
    setSelectedStageId(stageId);
  }, []);

  // L0 template belongs to session-init — only show when that stage is selected
  const showL0Template = selectedStageId === 'session-init';
  const visibleL0 = rulesData?.l0Prompts && shouldShowL0Section(rulesData.l0Prompts) ? rulesData.l0Prompts : undefined;

  const l0Slot =
    showL0Template && visibleL0 ? (
      <L0PromptsSection l0Prompts={visibleL0} onPreview={(file, label) => onPreview({ file, label })} />
    ) : undefined;

  return (
    <div className="space-y-6">
      <InjectionManifestContent onStageChange={handleStageChange} slotAfterCarrier={l0Slot} />

      {rulesError && (
        <SettingsText as="p" variant="sm" tone="red">
          {rulesError}
        </SettingsText>
      )}
    </div>
  );
}

// ── Tab 2: Agent Rules ──────────────────────────────────────

function AgentRulesTabContent({
  rulesData,
  rulesError,
  onPreview,
}: {
  rulesData: RulesData | null;
  rulesError: string | null;
  onPreview: (p: { file: RuleFile; label: string }) => void;
}) {
  if (rulesError)
    return (
      <SettingsText as="p" variant="sm" tone="red">
        {rulesError}
      </SettingsText>
    );
  if (!rulesData)
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        加载中...
      </SettingsText>
    );

  const sourceRules = rulesData.sharedRules.filter((r) => r.consumption.kind === 'actual-prompt');
  const referenceRules = rulesData.sharedRules.filter(
    (r) => r.consumption.kind === 'reference' || r.consumption.kind === 'skill-on-demand',
  );

  return (
    <div className="space-y-6">
      {sourceRules.length > 0 && (
        <SettingsSection
          title="注入源文件"
          description="编译到实际 prompt 中的源文件。经编译器提取后注入，非全文。"
          badge={<SettingsBadge tone="emerald">{sourceRules.length} files</SettingsBadge>}
        >
          <div className="space-y-3">
            {sourceRules.map((file) => (
              <RuleFileCard
                key={file.path}
                file={file}
                onClick={() => onPreview({ file, label: FILE_LABELS[file.path] ?? file.path })}
              />
            ))}
          </div>
        </SettingsSection>
      )}

      {referenceRules.length > 0 && (
        <SettingsSection
          title="参考文档与 SOP"
          description="Agent 按需加载的参考文档。不自动注入每次模型调用，但 Agent 可在需要时主动读取。"
          badge={<SettingsBadge tone="slate">{referenceRules.length} files</SettingsBadge>}
        >
          <div className="space-y-3">
            {referenceRules.map((file) => (
              <RuleFileCard
                key={file.path}
                file={file}
                onClick={() => onPreview({ file, label: FILE_LABELS[file.path] ?? file.path })}
              />
            ))}
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="模型指南"
        description="每只猫的角色定义和模型特定约束。"
        badge={<SettingsBadge tone="slate">{rulesData.providerGuides.length} guides</SettingsBadge>}
      >
        <div className="space-y-3">
          {rulesData.providerGuides.map((guide) => (
            <RuleFileCard
              key={guide.path}
              file={guide}
              label={PROVIDER_LABELS[guide.provider]}
              onClick={() => onPreview({ file: guide, label: PROVIDER_LABELS[guide.provider] ?? guide.path })}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}

// ── Rule preview modal ────────────────────────────────────────

function RulePreviewModal({ label, file, onClose }: { label: string; file: RuleFile; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const lineCount = file.content.split('\n').length;

  return createPortal(
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
            style={{ borderRadius: '0.75rem', fontSize: 'var(--console-font-base)', color: 'var(--cafe-text-muted)' }}
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
    </div>,
    document.body,
  );
}
