'use client';

import { SettingsBadge, SettingsCard, SettingsSection, SettingsText } from './primitives';

export type PromptConsumptionKind = 'actual-prompt' | 'harness-injected' | 'reference' | 'skill-on-demand';

export interface PromptConsumptionInfo {
  kind: PromptConsumptionKind;
  label: string;
  detail: string;
  consumers: string[];
}

export interface RuleFile {
  path: string;
  content: string;
  exists: boolean;
  consumption: PromptConsumptionInfo;
}

export interface ProviderGuide extends RuleFile {
  provider: string;
}

export interface L0CompiledForCat {
  catId: string;
  displayName: string;
  compiled: string;
  error: string | null;
  consumption: PromptConsumptionInfo;
}

export interface L0PromptsBlock {
  template: RuleFile;
  compiledByCat: L0CompiledForCat[];
  customization: { templatePath: string; compileScript: string; verifyCommand: string };
}

export const FILE_LABELS: Record<string, string> = {
  'cat-cafe-skills/refs/shared-rules.md': '家规（三猫共用协作规则）',
  'docs/SOP.md': '运维 SOP',
};

const CONSUMPTION_TONE: Record<PromptConsumptionKind, 'emerald' | 'amber' | 'blue' | 'purple'> = {
  'actual-prompt': 'emerald',
  'harness-injected': 'amber',
  reference: 'blue',
  'skill-on-demand': 'purple',
};

const LEGEND_ITEMS: Array<{ kind: PromptConsumptionKind; detail: string }> = [
  {
    kind: 'actual-prompt',
    detail: '实际进入 system/developer prompt 或 fallback prompt 的内容。',
  },
  {
    kind: 'harness-injected',
    detail: '由 provider/CLI 项目文档机制注入模型上下文；不是 native L0 真相源。',
  },
  {
    kind: 'reference',
    detail: '可查看、可人工参考，但不会自动注入每次模型调用。',
  },
  {
    kind: 'skill-on-demand',
    detail: '只有明确加载对应 skill 时才读取，不是常驻 prompt。',
  },
];

const LEGEND_LABELS: Record<PromptConsumptionKind, string> = {
  'actual-prompt': '实际进 prompt',
  'harness-injected': 'harness 注入',
  reference: '只是参考',
  'skill-on-demand': 'skill 按需加载',
};

export function shouldShowL0Section(l0Prompts?: L0PromptsBlock): boolean {
  return l0Prompts?.template.exists === true;
}

export function ConsumptionLegend() {
  return (
    <div
      className="grid gap-3 md:grid-cols-4"
      style={{
        borderRadius: '0.75rem',
        backgroundColor: 'var(--console-panel-bg)',
        padding: '0.75rem',
      }}
    >
      {LEGEND_ITEMS.map((item) => (
        <div key={item.kind} className="min-w-0">
          <SettingsBadge tone={CONSUMPTION_TONE[item.kind]}>{LEGEND_LABELS[item.kind]}</SettingsBadge>
          <SettingsText as="p" tone="muted" className="mt-2">
            {item.detail}
          </SettingsText>
        </div>
      ))}
    </div>
  );
}

function ConsumptionMeta({ consumption }: { consumption: PromptConsumptionInfo }) {
  return (
    <div className="mt-2 space-y-1">
      <SettingsText as="p" tone="muted">
        {consumption.detail}
      </SettingsText>
      {consumption.consumers.length > 0 && (
        <SettingsText as="p" tone="muted">
          消费链: {consumption.consumers.join(' / ')}
        </SettingsText>
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SettingsText as="p" variant="sm" tone="default" className="font-medium">
            {displayLabel}
          </SettingsText>
          <div className="flex flex-wrap items-center gap-2">
            <SettingsBadge tone={CONSUMPTION_TONE[file.consumption.kind]}>{file.consumption.label}</SettingsBadge>
            <SettingsBadge tone="amber">编译失败</SettingsBadge>
          </div>
        </div>
        <SettingsText as="p" tone="muted" className="mt-2">
          {errorMessage || '(无错误信息)'}
        </SettingsText>
        <ConsumptionMeta consumption={file.consumption} />
      </SettingsCard>
    );
  }

  if (!file.exists) {
    return (
      <SettingsCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SettingsText as="p" variant="sm" tone="default" className="font-medium">
            {displayLabel}
          </SettingsText>
          <div className="flex flex-wrap items-center gap-2">
            <SettingsBadge tone={CONSUMPTION_TONE[file.consumption.kind]}>{file.consumption.label}</SettingsBadge>
            <SettingsBadge tone="red">文件不存在</SettingsBadge>
          </div>
        </div>
        <SettingsText as="p" tone="muted" className="mt-2">
          {file.path}
        </SettingsText>
        <ConsumptionMeta consumption={file.consumption} />
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
            <SettingsBadge tone={CONSUMPTION_TONE[file.consumption.kind]}>{file.consumption.label}</SettingsBadge>
            <SettingsBadge tone="blue">可预览</SettingsBadge>
          </div>
          <SettingsText as="p" tone="muted" className="mt-1">
            {file.path} · {lineCount} 行
          </SettingsText>
          <ConsumptionMeta consumption={file.consumption} />
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
      description="shared-rules.md 编译成 governance L0 后，与 L0 template 一起进入 native system role / fallback prompt；这里展示 template 和 per-cat 实际编译产物。"
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
            consumption: c.consumption,
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
            fontSize: 'var(--console-font-xs)',
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
