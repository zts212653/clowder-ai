'use client';

import type { CatData } from '@/hooks/useCatData';
import {
  CODEX_APPROVAL_OPTIONS,
  CODEX_AUTH_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  SESSION_CHAIN_OPTIONS,
  SESSION_STRATEGY_OPTIONS,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
  type StrategyFormState,
} from './hub-cat-editor.model';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';

type FormPatch = Partial<HubCatEditorFormState>;

export function AdvancedRuntimeSection({
  cat,
  form,
  strategyForm,
  loadingStrategy,
  strategyError,
  codexSettings,
  loadingCodexSettings,
  codexSettingsError,
  showCodexSettings,
  onChange,
  onStrategyChange,
  onCodexChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  strategyForm: StrategyFormState | null;
  loadingStrategy: boolean;
  strategyError: string | null;
  codexSettings: CodexRuntimeSettings | null;
  loadingCodexSettings: boolean;
  codexSettingsError: string | null;
  showCodexSettings: boolean;
  onChange: (patch: FormPatch) => void;
  onStrategyChange: (patch: Partial<StrategyFormState>) => void;
  onCodexChange: (patch: Partial<CodexRuntimeSettings>) => void;
}) {
  const effectiveCodexSettings = codexSettings ?? {
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
    authMode: 'oauth' as const,
  };

  return (
    <SectionCard
      title="高级运行时参数"
      description="contextBudget + Session 策略 + Client 特有参数。🏷️ 标记的参数仅在选择对应 Client 时显示。"
      tone="success"
    >
      <p className="text-xs leading-5 text-[#6C7A6D]">上下文预算会随成员配置一起持久化到运行时 catalog。4 项要么全部留空，要么全部填写。</p>
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Max Prompt Tokens"
          value={form.maxPromptTokens}
          onChange={(value) => onChange({ maxPromptTokens: value })}
          inputMode="numeric"
        />
        <TextField
          label="Max Context Tokens"
          value={form.maxContextTokens}
          onChange={(value) => onChange({ maxContextTokens: value })}
          inputMode="numeric"
        />
        <TextField
          label="Max Messages"
          value={form.maxMessages}
          onChange={(value) => onChange({ maxMessages: value })}
          inputMode="numeric"
        />
        <TextField
          label="Max Content Length"
          ariaLabel="Max Content Length"
          value={form.maxContentLengthPerMsg}
          onChange={(value) => onChange({ maxContentLengthPerMsg: value })}
          inputMode="numeric"
        />
        <SelectField
          label="Session Chain"
          value={form.sessionChain}
          options={SESSION_CHAIN_OPTIONS}
          onChange={(value) => onChange({ sessionChain: value as HubCatEditorFormState['sessionChain'] })}
        />
      </div>

      {cat ? (
        <div className="space-y-3 rounded-2xl border border-[#DCE9E0] bg-white/80 p-4">
          {loadingStrategy ? <p className="text-sm text-[#7F7168]">Session 策略加载中...</p> : null}
          {strategyError ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{strategyError}</p> : null}
          {strategyForm ? (
            <div className="grid gap-4 md:grid-cols-2">
              <SelectField
                label="Session Strategy"
                value={strategyForm.strategy}
                options={SESSION_STRATEGY_OPTIONS.filter(
                  (option) => option.value !== 'hybrid' || strategyForm.hybridCapable,
                )}
                onChange={(value) => onStrategyChange({ strategy: value as StrategyFormState['strategy'] })}
              />
              <TextField
                label="Warn Threshold"
                value={strategyForm.warnThreshold}
                onChange={(value) => onStrategyChange({ warnThreshold: value })}
                inputMode="decimal"
              />
              <TextField
                label="Action Threshold"
                value={strategyForm.actionThreshold}
                onChange={(value) => onStrategyChange({ actionThreshold: value })}
                inputMode="decimal"
              />
              {strategyForm.strategy === 'hybrid' ? (
                <TextField
                  label="Max Compressions"
                  value={strategyForm.maxCompressions}
                  onChange={(value) => onStrategyChange({ maxCompressions: value })}
                  inputMode="numeric"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showCodexSettings ? (
        <div className="space-y-3 rounded-2xl border border-[#DCE9E0] bg-white/80 p-4">
          {loadingCodexSettings ? <p className="text-sm text-[#7F7168]">Codex 运行参数加载中...</p> : null}
          {codexSettingsError ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{codexSettingsError}</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-3">
            <SelectField
              label="Codex Sandbox 🏷️"
              ariaLabel="Codex Sandbox 🏷️"
              value={effectiveCodexSettings.sandboxMode}
              options={CODEX_SANDBOX_OPTIONS}
              onChange={(value) => onCodexChange({ sandboxMode: value as CodexRuntimeSettings['sandboxMode'] })}
            />
            <SelectField
              label="Codex Approval 🏷️"
              ariaLabel="Codex Approval 🏷️"
              value={effectiveCodexSettings.approvalPolicy}
              options={CODEX_APPROVAL_OPTIONS}
              onChange={(value) => onCodexChange({ approvalPolicy: value as CodexRuntimeSettings['approvalPolicy'] })}
            />
            <SelectField
              label="Codex Auth Mode 🏷️"
              ariaLabel="Codex Auth Mode 🏷️"
              value={effectiveCodexSettings.authMode}
              options={CODEX_AUTH_MODE_OPTIONS}
              onChange={(value) => onCodexChange({ authMode: value as CodexRuntimeSettings['authMode'] })}
            />
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
