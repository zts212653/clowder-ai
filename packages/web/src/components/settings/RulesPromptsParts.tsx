'use client';

import { SettingsBadge, SettingsCard, SettingsText } from './primitives';

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

  // When nested inside SettingsSection (层4), cards use 层3 for depth hierarchy
  const nestedStyle = { backgroundColor: 'var(--console-elevated-bg)' };

  if (errorMessage !== undefined) {
    return (
      <SettingsCard style={nestedStyle}>
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
      <SettingsCard style={nestedStyle}>
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
    <SettingsCard onClick={onClick} style={nestedStyle}>
      <div className="flex w-full items-center justify-between gap-3">
        <div className="min-w-0">
          <SettingsText as="p" variant="sm" tone="default" className="font-medium">
            {displayLabel}
          </SettingsText>
          <SettingsText as="p" tone="muted" className="mt-1">
            {file.path} · {lineCount} 行
          </SettingsText>
        </div>
        <span className="shrink-0 text-xs opacity-50">查看</span>
      </div>
    </SettingsCard>
  );
}

/**
 * F203 Phase F / F237 — L0 system prompt template viewer.
 * Styled as a segment row to be consistent with StageDetailPanels SegmentRow.
 */
export function L0PromptsSection({
  l0Prompts,
  onPreview,
}: {
  l0Prompts: L0PromptsBlock;
  onPreview: (file: RuleFile, label: string) => void;
}) {
  const lineCount = l0Prompts.template.content.split('\n').length;

  return (
    <div
      className="space-y-2 rounded-xl p-3"
      style={{ backgroundColor: 'var(--console-card-bg)', boxShadow: '0 8px 22px rgba(43,33,26,0.04)' }}
    >
      <SettingsText as="h4" variant="sm" tone="default" className="font-semibold">
        L0 系统提示词模板
      </SettingsText>
      <SettingsText as="p" variant="xs" tone="muted">
        下方注入段的真相源模板。编译器按猫替换占位变量（身份、队友名册、工作流触发点）后生成最终系统提示词。
      </SettingsText>
      {/* Template row — 层3 抬升, shadow emphasis since 层3/层4 visually close */}
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left hover:opacity-80"
        style={{
          backgroundColor: 'var(--console-elevated-bg)',
          boxShadow: '0 1px 4px rgba(43,33,26,0.08)',
        }}
        onClick={() => onPreview(l0Prompts.template, 'L0 Template — system-prompt-l0.md')}
      >
        <SettingsText as="span" variant="xs" tone="muted" className="mt-0.5 w-8 shrink-0 font-mono">
          L0
        </SettingsText>
        <div className="min-w-0 flex-1">
          <SettingsText as="span" variant="sm" tone="default" className="font-medium">
            L0 Template（含占位变量）
          </SettingsText>
          <SettingsText as="p" variant="xs" tone="secondary" className="mt-0.5">
            {l0Prompts.customization.templatePath} · {lineCount} 行
          </SettingsText>
        </div>
        <span className="mt-0.5 shrink-0 text-xs opacity-50">查看</span>
      </button>
    </div>
  );
}
