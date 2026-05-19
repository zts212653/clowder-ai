'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsCard, SettingsSection, SettingsText } from './primitives';

interface RuleFile {
  path: string;
  content: string;
  exists: boolean;
}

interface ProviderGuide extends RuleFile {
  provider: string;
}

interface L0CompiledForCat {
  catId: string;
  displayName: string;
  compiled: string;
  error: string | null;
}

interface L0PromptsBlock {
  template: RuleFile;
  compiledByCat: L0CompiledForCat[];
  customization: { templatePath: string; compileScript: string; verifyCommand: string };
}

interface RulesData {
  sharedRules: RuleFile[];
  providerGuides: ProviderGuide[];
  l0Prompts?: L0PromptsBlock;
}

export function shouldShowL0Section(l0Prompts?: L0PromptsBlock): boolean {
  return l0Prompts?.template.exists === true;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: '布偶猫 (Claude)',
  codex: '缅因猫 (Codex)',
  gemini: '暹罗猫 (Gemini)',
};

const FILE_LABELS: Record<string, string> = {
  'cat-cafe-skills/refs/shared-rules.md': '家规（三猫共用协作规则）',
  'docs/SOP.md': '运维 SOP',
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

  return (
    <div className="space-y-6">
      <SettingsSection
        title="共享规则"
        description="全部成员遵循的协作规则和流程规范（shared-rules.md 摘要注入系统提示词，SOP.md 为参考文档）"
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

      {shouldShowL0Section(data.l0Prompts) && (
        <L0PromptsSection l0Prompts={data.l0Prompts!} onPreview={(file, label) => setPreviewFile({ file, label })} />
      )}

      {previewFile && (
        <RulePreviewModal label={previewFile.label} file={previewFile.file} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}

export function RuleFileCard({
  file,
  label,
  onClick,
  errorMessage,
}: {
  file: RuleFile;
  label?: string;
  onClick: () => void;
  /** F203 Phase F: compile-failed compiled L0 — distinct UX from missing file. */
  errorMessage?: string;
}) {
  const displayLabel = label ?? FILE_LABELS[file.path] ?? file.path;

  if (errorMessage !== undefined) {
    return (
      <SettingsCard>
        <div className="flex items-center justify-between gap-3">
          <SettingsText as="p" variant="sm" tone="default" className="font-medium">
            {displayLabel}
          </SettingsText>
          <SettingsBadge tone="amber">编译失败</SettingsBadge>
        </div>
        <SettingsText as="p" tone="muted" className="mt-2">
          {errorMessage || '(无错误信息)'}
        </SettingsText>
      </SettingsCard>
    );
  }

  if (!file.exists) {
    return (
      <SettingsCard>
        <div className="flex items-center justify-between gap-3">
          <SettingsText as="p" variant="sm" tone="default" className="font-medium">
            {displayLabel}
          </SettingsText>
          <SettingsBadge tone="red">文件不存在</SettingsBadge>
        </div>
        <SettingsText as="p" tone="muted" className="mt-2">
          {file.path}
        </SettingsText>
      </SettingsCard>
    );
  }

  const lineCount = file.content.split('\n').length;

  return (
    <SettingsCard onClick={onClick}>
      <div className="flex w-full items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SettingsText as="p" variant="sm" tone="default" className="font-medium">
              {displayLabel}
            </SettingsText>
            <SettingsBadge tone="blue">可预览</SettingsBadge>
          </div>
          <SettingsText as="p" tone="muted" className="mt-1">
            {file.path} · {lineCount} 行
          </SettingsText>
        </div>
        <span
          className="console-pill flex h-10 w-10 shrink-0 items-center justify-center"
          style={{ borderRadius: '9999px', color: 'var(--cafe-text-secondary)' }}
        >
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </div>
    </SettingsCard>
  );
}

/**
 * F203 Phase F — L0 system prompt section (read-only viewer).
 * Renders the L0 template card + per-cat compiled cards + customization paths.
 * Wired into RulesPromptsContent as 3rd Section. Props-driven for testability;
 * async fetch + modal interaction stay in RulesPromptsContent.
 */
export function L0PromptsSection({
  l0Prompts,
  onPreview,
}: {
  l0Prompts: L0PromptsBlock;
  onPreview: (file: RuleFile, label: string) => void;
}) {
  return (
    <SettingsSection
      title="L0 系统提示词"
      description="替换式注入到每只猫的 native system role（Phase C 起；客观性指令 carry-over 保留）。template 是真相源；per-cat 渲染是 compileL0 实际产出。"
      badge={<SettingsBadge tone="slate">1 template + {l0Prompts.compiledByCat.length} cats</SettingsBadge>}
    >
      <div className="space-y-3">
        <RuleFileCard
          file={l0Prompts.template}
          label="L0 Template（含占位）"
          onClick={() => onPreview(l0Prompts.template, 'L0 Template — system-prompt-l0.md')}
        />
        {l0Prompts.compiledByCat.map((c) => {
          const compiledFile: RuleFile = {
            path: `compiled://${c.catId}`,
            content: c.compiled,
            exists: c.error === null,
          };
          return (
            <RuleFileCard
              key={c.catId}
              file={compiledFile}
              label={c.displayName}
              onClick={() => onPreview(compiledFile, `${c.displayName} — compiled L0`)}
              errorMessage={c.error ?? undefined}
            />
          );
        })}
        <div
          className="leading-5"
          style={{
            borderRadius: '0.75rem',
            backgroundColor: 'var(--console-panel-bg)',
            padding: '0.75rem',
            fontSize: '0.75rem',
            color: 'var(--cafe-text-muted)',
          }}
        >
          <SettingsText as="p" tone="secondary" className="font-medium">
            如何修改 L0（read-only viewer，编辑入口在文件系统）
          </SettingsText>
          <SettingsText as="p" tone="muted" className="mt-1">
            Template 真相源: <code>{l0Prompts.customization.templatePath}</code>
          </SettingsText>
          <SettingsText as="p" tone="muted">
            Per-cat 渲染逻辑: <code>{l0Prompts.customization.compileScript}</code>
          </SettingsText>
          <SettingsText as="p" tone="muted">
            改完验证: {l0Prompts.customization.verifyCommand}
          </SettingsText>
        </div>
      </div>
    </SettingsSection>
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
              fontSize: '1.125rem',
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
              className="font-extrabold"
              style={{ fontSize: '1.25rem' }}
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
              fontSize: '1rem',
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
            style={{ fontSize: '0.75rem', color: 'var(--cafe-text-secondary)' }}
          >
            {file.content}
          </pre>
        </div>
      </div>
    </div>
  );
}
