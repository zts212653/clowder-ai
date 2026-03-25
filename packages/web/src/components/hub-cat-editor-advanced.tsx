'use client';

import type { CatData } from '@/hooks/useCatData';
import {
  CODEX_APPROVAL_OPTIONS,
  CODEX_AUTH_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
  SESSION_CHAIN_OPTIONS,
  SESSION_STRATEGY_OPTIONS,
  type StrategyFormState,
} from './hub-cat-editor.model';
import { RangeField, SectionCard, SelectField, TextField } from './hub-cat-editor-fields';
import { TagEditor } from './hub-tag-editor';

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
  codexSettingsEditable,
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
  codexSettingsEditable: boolean;
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
      description="contextBudget + Session 策略 + Client 特有参数。标有 (Codex) 的参数仅在选择对应 Client 时显示。"
      tone="success"
    >
      <p className="text-xs leading-5 text-[#6C7A6D]">
        上下文预算会随成员配置一起持久化到运行时 catalog。4 项要么全部留空，要么全部填写。
      </p>
      <div className="space-y-2">
        <TextField
          label="Max Prompt Tokens"
          value={form.maxPromptTokens}
          onChange={(value) => onChange({ maxPromptTokens: value })}
          inputMode="numeric"
          tone="success"
          placeholder="留空默认 48000"
        />
        <TextField
          label="Max Context Tokens"
          value={form.maxContextTokens}
          onChange={(value) => onChange({ maxContextTokens: value })}
          inputMode="numeric"
          tone="success"
          placeholder="留空默认 128000"
        />
        <TextField
          label="Max Messages"
          value={form.maxMessages}
          onChange={(value) => onChange({ maxMessages: value })}
          inputMode="numeric"
          tone="success"
          placeholder="留空默认 50"
        />
        <TextField
          label="Max Content Length Per Msg"
          ariaLabel="Max Content Length Per Msg"
          value={form.maxContentLengthPerMsg}
          onChange={(value) => onChange({ maxContentLengthPerMsg: value })}
          inputMode="numeric"
          tone="success"
          placeholder="留空默认 16000"
        />
        <SelectField
          label="Session Chain"
          value={form.sessionChain}
          options={SESSION_CHAIN_OPTIONS}
          onChange={(value) => onChange({ sessionChain: value as HubCatEditorFormState['sessionChain'] })}
          tone="success"
        />
        {form.client === 'opencode' ? (
          <div className="space-y-1">
            <TextField
              label="OpenCode Provider 名称"
              value={form.ocProviderName}
              onChange={(value) => onChange({ ocProviderName: value })}
              tone="success"
              placeholder="例如 maas、deepseek（留空 = 使用内置 provider）"
            />
            <p className="text-[11px] leading-4 text-[#8A776B]">
              自定义 API Key 认证时需要。运行时自动组装为 provider/model 格式路由到 opencode CLI。
            </p>
          </div>
        ) : null}
        {form.client === 'openai' || form.client === 'opencode' ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-[#3D2E22]">额外 CLI 参数</p>
            <TagEditor
              tags={form.cliConfigArgs}
              onChange={(nextTags) => onChange({ cliConfigArgs: nextTags })}
              addLabel="+ 添加参数"
              placeholder={
                form.client === 'opencode' ? '例如 --variant low' : '例如 --config model_reasoning_effort="low"'
              }
              emptyLabel="无额外参数"
              tone="green"
            />
            <p className="text-[11px] leading-4 text-[#8A776B]">
              每条直接追加到 CLI 命令，不做隐式转换。 参考：
              {form.client === 'opencode' ? (
                <a href="https://opencode.ai/docs/cli" target="_blank" rel="noreferrer" className="underline">
                  OpenCode CLI
                </a>
              ) : (
                <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer" className="underline">
                  Codex CLI
                </a>
              )}
            </p>
          </div>
        ) : null}
      </div>

      {cat ? (
        <div className="space-y-3 rounded-2xl border border-[#DCE9E0] bg-white/80 p-4">
          {loadingStrategy ? <p className="text-sm text-[#7F7168]">Session 策略加载中...</p> : null}
          {strategyError ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{strategyError}</p>
          ) : null}
          {strategyForm ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-[#CFE5D5] bg-[#F5FBF6] px-4 py-3 text-xs leading-5 text-[#6C7A6D]">
                阈值基于 context 填充率 = 当前 tokens / Max Context Tokens。拖动滑条调节百分比。
              </div>
              <div className="space-y-2">
                <SelectField
                  label="Session Strategy"
                  value={strategyForm.strategy}
                  options={SESSION_STRATEGY_OPTIONS.filter(
                    (option) => option.value !== 'hybrid' || strategyForm.hybridCapable,
                  )}
                  onChange={(value) => onStrategyChange({ strategy: value as StrategyFormState['strategy'] })}
                  tone="success"
                />
                <RangeField
                  label="Session Warn Threshold"
                  value={strategyForm.warnThreshold}
                  onChange={(value) => onStrategyChange({ warnThreshold: value })}
                  hint="context 填充到此比例时前端弹出警告提示"
                />
                <RangeField
                  label="Session Action Threshold"
                  value={strategyForm.actionThreshold}
                  onChange={(value) => onStrategyChange({ actionThreshold: value })}
                  hint="context 填充到此比例时触发 Session 策略动作（如 handoff 换 session）"
                />
                {strategyForm.strategy === 'hybrid' ? (
                  <TextField
                    label="Max Compressions"
                    value={strategyForm.maxCompressions}
                    onChange={(value) => onStrategyChange({ maxCompressions: value })}
                    inputMode="numeric"
                    tone="success"
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
          {!loadingCodexSettings && !codexSettingsEditable ? (
            <p className="rounded-xl border border-[#F5D2B8] bg-[#FFF4EC] px-3 py-2 text-xs leading-5 text-[#C27D52]">
              Codex 配置基线未加载成功，以下 3 项已禁用；请刷新后重试，避免保存时误以为已生效。
            </p>
          ) : null}
          <p className="text-center text-xs font-semibold text-[#B59A88]">── Codex 专属 (仅 Client=Codex 时显示) ──</p>
          <p className="rounded-xl border border-[#CFE5D5] bg-[#F5FBF6] px-3 py-2 text-xs leading-5 text-[#6C7A6D]">
            成员资料与 Codex 执行参数收敛到同一个入口保存。保存后会分别写入成员 overlay 与全局运行配置。
          </p>
          <div className="space-y-2">
            <SelectField
              label="Codex Sandbox (Codex)"
              ariaLabel="Codex Sandbox"
              value={effectiveCodexSettings.sandboxMode}
              options={CODEX_SANDBOX_OPTIONS}
              onChange={(value) => onCodexChange({ sandboxMode: value as CodexRuntimeSettings['sandboxMode'] })}
              disabled={!codexSettingsEditable}
              tone="success"
            />
            <SelectField
              label="Codex Approval (Codex)"
              ariaLabel="Codex Approval"
              value={effectiveCodexSettings.approvalPolicy}
              options={CODEX_APPROVAL_OPTIONS}
              onChange={(value) => onCodexChange({ approvalPolicy: value as CodexRuntimeSettings['approvalPolicy'] })}
              disabled={!codexSettingsEditable}
              tone="success"
            />
            <SelectField
              label="Codex Auth Mode (Codex)"
              ariaLabel="Codex Auth Mode"
              value={effectiveCodexSettings.authMode}
              options={CODEX_AUTH_MODE_OPTIONS}
              onChange={(value) => onCodexChange({ authMode: value as CodexRuntimeSettings['authMode'] })}
              disabled={!codexSettingsEditable}
              tone="success"
            />
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
