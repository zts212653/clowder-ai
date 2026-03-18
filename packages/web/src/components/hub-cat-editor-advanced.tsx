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
import { RangeField, SectionCard, SelectField, TextField } from './hub-cat-editor-fields';

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
          label="Max Content Length Per Msg"
          ariaLabel="Max Content Length Per Msg"
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
            <div className="space-y-4">
              <div className="rounded-2xl border border-[#CFE5D5] bg-[#F5FBF6] px-4 py-3 text-xs leading-5 text-[#6C7A6D]">
                📊 阈值基于 context 填充率 = 当前 tokens / Max Context Tokens。拖动滑条调节百分比。
              </div>
              <div className="grid gap-4 md:grid-cols-2">
              <SelectField
                label="Session Strategy"
                value={strategyForm.strategy}
                options={SESSION_STRATEGY_OPTIONS.filter(
                  (option) => option.value !== 'hybrid' || strategyForm.hybridCapable,
                )}
                onChange={(value) => onStrategyChange({ strategy: value as StrategyFormState['strategy'] })}
              />
              <RangeField
                label="Session Warn Threshold"
                value={strategyForm.warnThreshold}
                onChange={(value) => onStrategyChange({ warnThreshold: value })}
                hint="⚡ context 填充到此比例时前端弹出警告提示"
              />
              <RangeField
                label="Session Action Threshold"
                value={strategyForm.actionThreshold}
                onChange={(value) => onStrategyChange({ actionThreshold: value })}
                hint="🔥 context 填充到此比例时触发 Session 策略动作（如 handoff 换 session）"
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
          <p className="text-center text-xs font-semibold text-[#B59A88]">── Codex 专属 (仅 Client=Codex 时显示) ──</p>
          <p className="rounded-xl border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-2 text-xs text-[#7F7168]">
            这 3 项是全局运行参数（非成员级），此处仅展示当前值；如需修改请在全局配置入口调整。
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <SelectField
              label="Codex Sandbox 🏷️"
              ariaLabel="Codex Sandbox 🏷️"
              value={effectiveCodexSettings.sandboxMode}
              options={CODEX_SANDBOX_OPTIONS}
              onChange={(value) => onCodexChange({ sandboxMode: value as CodexRuntimeSettings['sandboxMode'] })}
              disabled
            />
            <SelectField
              label="Codex Approval 🏷️"
              ariaLabel="Codex Approval 🏷️"
              value={effectiveCodexSettings.approvalPolicy}
              options={CODEX_APPROVAL_OPTIONS}
              onChange={(value) => onCodexChange({ approvalPolicy: value as CodexRuntimeSettings['approvalPolicy'] })}
              disabled
            />
            <SelectField
              label="Codex Auth Mode 🏷️"
              ariaLabel="Codex Auth Mode 🏷️"
              value={effectiveCodexSettings.authMode}
              options={CODEX_AUTH_MODE_OPTIONS}
              onChange={(value) => onCodexChange({ authMode: value as CodexRuntimeSettings['authMode'] })}
              disabled
            />
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
