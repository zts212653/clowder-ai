'use client';

import type { CatData } from '@/hooks/useCatData';
import {
  CODEX_APPROVAL_OPTIONS,
  CODEX_AUTH_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  type CodexRuntimeSettings,
  getCliEffortOptionsForClient,
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
  const cliEffortOptions = getCliEffortOptionsForClient(form.clientId, form.defaultModel);
  const sessionChainEnabled = form.sessionChain === 'true' && (strategyForm?.sessionChainEnabled ?? true);

  return (
    <SectionCard
      title="高级运行时参数"
      description="Context Window + Session 策略 + Client 特有参数。标有 (Codex) 的参数仅在选择对应 Client 时显示。"
      tone="success"
    >
      <div className="space-y-2">
        <TextField
          label="Context Window"
          value={form.contextWindow}
          onChange={(value) => onChange({ contextWindow: value })}
          inputMode="numeric"
          tone="success"
          placeholder="留空或 0 = Auto（由 CLI / 模型目录自动探测）"
        />
        <p className="text-xs leading-5 text-[var(--console-runtime-hint)]">
          填写正整数 = Manual 模式，限制该成员的上下文窗口 token 上限。留空或填 0 = Auto，由运行时自动探测。
        </p>
        <ResolvedContextInfo cat={cat} form={form} />
        <SelectField
          label="Session Chain"
          value={form.sessionChain}
          options={SESSION_CHAIN_OPTIONS}
          onChange={(value) => onChange({ sessionChain: value as HubCatEditorFormState['sessionChain'] })}
          tone="success"
        />
        {cliEffortOptions ? (
          <>
            <TextField
              label="CLI Effort"
              value={form.cliEffort}
              onChange={(value) => onChange({ cliEffort: value })}
              placeholder="留空使用 Client 默认值；也可输入原生值，例如 ultra"
              suggestions={cliEffortOptions}
              tone="success"
            />
            <p className="-mt-1 text-label leading-4 text-cafe-muted">
              维护 preset：{cliEffortOptions.join(' / ')}。也可直接输入所选 CLI 支持的原生值；CLI
              会返回其自身的校验错误。
            </p>
          </>
        ) : null}
        {form.clientId !== 'antigravity' && form.clientId !== 'catagent' ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-cafe">额外 CLI 参数</p>
            <TagEditor
              tags={form.cliConfigArgs}
              onChange={(nextTags) => onChange({ cliConfigArgs: nextTags })}
              addLabel="+ 添加参数"
              placeholder="例如 --model xxx 或 --flag value"
              emptyLabel="无额外参数"
              tone="green"
            />
            <p className="text-label leading-4 text-cafe-muted">
              每条直接追加到 CLI 命令，与系统参数重复时以用户参数为准。`CLI Effort` 请优先用上面的结构化字段。
            </p>
          </div>
        ) : null}
      </div>

      {cat ? (
        <div className="space-y-3 rounded-[14px] bg-[var(--console-runtime-group-bg)] p-[14px]">
          {loadingStrategy ? <p className="text-sm text-cafe-secondary">Session 策略加载中...</p> : null}
          {strategyError ? (
            <p className="rounded-[20px] border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">
              {strategyError}
            </p>
          ) : null}
          {strategyForm && !sessionChainEnabled ? (
            <div className="rounded-[10px] bg-[var(--console-field-bg)] px-4 py-3 text-xs leading-5 text-[var(--cafe-accent)]">
              <p className="font-semibold">Session Chain 未开启</p>
              <p>
                当前成员不会记录或续接 Session Chain，下面的 Session 策略不会生效；先开启 Session Chain 后再配置策略。
              </p>
            </div>
          ) : null}
          {strategyForm && sessionChainEnabled ? (
            <div className="space-y-4">
              <div className="rounded-[10px] bg-[var(--console-runtime-field-bg)] px-4 py-3 text-xs leading-5 text-[var(--console-runtime-hint)]">
                <p>阈值基于 context 填充率 = 当前 tokens / Max Context Tokens。拖动滑条调节百分比。</p>
                <StrategyCapabilityNote cat={cat} />
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
                  label={strategyForm.strategy === 'compress' ? 'Session Observe Threshold' : 'Session Warn Threshold'}
                  value={strategyForm.warnThreshold}
                  onChange={(value) => onStrategyChange({ warnThreshold: value })}
                  hint={
                    strategyForm.strategy === 'compress'
                      ? 'context 填充到此比例时前端弹出观测提示（compress 下仅观测，不触发封印）'
                      : 'context 填充到此比例时前端弹出警告提示'
                  }
                />
                <RangeField
                  label={
                    strategyForm.strategy === 'compress'
                      ? 'Session Observe Threshold (upper)'
                      : 'Session Action Threshold'
                  }
                  value={strategyForm.actionThreshold}
                  onChange={(value) => onStrategyChange({ actionThreshold: value })}
                  hint={
                    strategyForm.strategy === 'compress'
                      ? 'compress 策略下此阈值仅用于观测，不触发封印。Session 会在 CLI 压缩后继续存活'
                      : 'context 填充到此比例时触发 Session 策略动作（如 handoff 换 session）'
                  }
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
        <div className="space-y-3 rounded-[14px] bg-[var(--console-runtime-group-bg)] p-[14px]">
          {loadingCodexSettings ? <p className="text-sm text-cafe-secondary">Codex 运行参数加载中...</p> : null}
          {codexSettingsError ? (
            <p className="rounded-[20px] border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">
              {codexSettingsError}
            </p>
          ) : null}
          {!loadingCodexSettings && !codexSettingsEditable ? (
            <p className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2 text-xs leading-5 text-[var(--cafe-accent)]">
              Codex 配置基线未加载成功，以下 3 项已禁用；请刷新后重试，避免保存时误以为已生效。
            </p>
          ) : null}
          <p className="text-center text-xs font-semibold text-cafe-muted">── Codex 专属 (仅 Client=Codex 时显示) ──</p>
          <p className="rounded-[10px] bg-[var(--console-runtime-field-bg)] px-3 py-2 text-xs leading-5 text-[var(--console-runtime-hint)]">
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

// ─── #1208 Item 4: Resolved Context Info ─────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  exact: 'CLI 实时上报',
  manual: '手动设置',
  catalog: '模型目录',
  default: '默认值',
};

const CONFIDENCE_BADGES: Record<string, string> = {
  exact: '✓ 精确',
  manual: '✓ 手动',
  catalog: '≈ 目录',
  default: '? 默认',
};

/** Show resolved context window info below the Context Window field. */
function ResolvedContextInfo({ cat, form }: { cat?: CatData | null; form: HubCatEditorFormState }) {
  if (!cat) return null;

  // Detect binding change: model/client changed in form → resolved context is stale.
  const bindingChanged = form.defaultModel !== cat.defaultModel || form.clientId !== cat.clientId;

  if (bindingChanged) {
    return (
      <p className="text-xs leading-5 text-[var(--cafe-accent)]">
        模型或 Client 已变更，保存后将重新解析 Context Window。
      </p>
    );
  }

  const rc = cat.resolvedContext;
  if (!rc || !rc.source) {
    return (
      <div className="text-xs leading-5 text-cafe-muted">
        <p>⚠ 未能解析 Context Window — 无已知的模型目录条目或 CLI 上报值。</p>
        {rc?.capabilityReason ? <p className="mt-0.5">原因: {rc.capabilityReason}</p> : null}
      </div>
    );
  }

  const badge = CONFIDENCE_BADGES[rc.source] ?? rc.source;
  const sourceLabel = SOURCE_LABELS[rc.source] ?? rc.source;
  const windowK = rc.windowTokens ? Math.round(rc.windowTokens / 1000) : 0;

  return (
    <div className="rounded-[8px] border border-[var(--console-runtime-group-bg)] bg-[var(--console-field-bg)] px-3 py-2 text-xs leading-5 text-cafe-secondary">
      <p>
        <span className="font-semibold">{badge}</span>
        {' · '}
        解析值: {windowK}K tokens
        {' · '}
        来源: {sourceLabel}
        {rc.actionable ? '' : '（仅供参考，不触发自动 Session 操作）'}
      </p>
      <p className="mt-0.5 text-cafe-muted">{rc.provenance}</p>
    </div>
  );
}

/** Session Strategy capability note: explain why actionable matters. */
function StrategyCapabilityNote({ cat }: { cat?: CatData | null }) {
  if (!cat) return null;
  const rc = cat.resolvedContext;
  const capReason = rc?.capabilityReason;
  if (!rc || !rc.source) {
    return (
      <p className="mt-1 text-[var(--cafe-accent)]">
        ⚠ Context Window 未解析：自动 Session 策略动作（handoff/seal）不会触发。
        {capReason ? ` ${capReason}。` : ' 请手动设置 Context Window 或等待 CLI 上报。'}
      </p>
    );
  }
  if (!rc.actionable) {
    return (
      <p className="mt-1 text-[var(--cafe-accent)]">
        当前 Context Window 来自{SOURCE_LABELS[rc.source] ?? rc.source}
        （置信度 {Math.round((rc.confidence ?? 0) * 100)}%），自动 Session 策略动作不会触发。
        {capReason ? ` ${capReason}。` : ' 手动设置 Context Window 可启用自动动作。'}
      </p>
    );
  }
  return null;
}
