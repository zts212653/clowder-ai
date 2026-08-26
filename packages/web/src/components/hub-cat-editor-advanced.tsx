'use client';

import { getContextWindowFallback } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { HubSessionStrategyEditor } from './HubSessionStrategyEditor';
import {
  CODEX_APPROVAL_OPTIONS,
  CODEX_AUTH_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  type CodexRuntimeSettings,
  getCliEffortOptionsForClient,
  type HubCatEditorFormState,
  type StrategyFormState,
  usesCliTransport,
} from './hub-cat-editor.model';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';
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
  codexSpeedVisible,
  codexFastSupported,
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
  codexSpeedVisible?: boolean;
  codexFastSupported?: boolean;
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
  const cliExtensionsAvailable = usesCliTransport(form);

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
          placeholder="留空或 0 = Auto；正整数 = Manual"
          ariaDescribedBy="context-window-compat-notice"
        />
        <p className="text-xs leading-5 text-[var(--console-runtime-hint)]">
          填写正整数 = Manual 模式，作为该成员的上下文窗口大小。留空或填 0 = Auto，由运行时自动探测。
        </p>
        <ContextWindowCompatibilityNotice cat={cat} form={form} />
        {cliExtensionsAvailable && cliEffortOptions ? (
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
        {codexSpeedVisible ? (
          <div className="space-y-1">
            <SelectField
              label="速度档位"
              value={form.codexSpeed ?? ''}
              options={[
                { value: '', label: '继承 Codex 设置' },
                { value: 'standard', label: 'Standard' },
                {
                  value: 'fast',
                  label: codexFastSupported ? 'Fast' : 'Fast（当前模型不可用）',
                  disabled: !codexFastSupported,
                },
              ]}
              onChange={(value) => onChange({ codexSpeed: value as HubCatEditorFormState['codexSpeed'] })}
              tone="success"
            />
            <p className="text-label leading-4 text-cafe-muted">
              仅 Codex OAuth 可用；这是请求档位，不代表上游最终实际服务档位。与 CLI Effort（思考深度）互不影响。
            </p>
          </div>
        ) : null}
        {cliExtensionsAvailable ? (
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
              每条直接追加到 CLI 命令。普通重复参数以用户参数为准；`CLI Effort`、`速度档位`
              等结构化保留项始终以上方字段为准，对应 raw 参数会被忽略。
            </p>
          </div>
        ) : null}
      </div>

      {cat ? (
        <HubSessionStrategyEditor
          strategyForm={strategyForm}
          loading={loadingStrategy}
          error={strategyError}
          onChange={onStrategyChange}
        />
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

function selectionMatchesSavedContext(cat: CatData | null | undefined, form: HubCatEditorFormState): boolean {
  if (!cat || cat.clientId !== form.clientId || Boolean(cat.acp) !== form.acpEnabled) return false;
  if (form.clientId !== 'openai') return true;
  return (cat.cli?.carrier ?? '') === form.codexCarrier;
}

function draftCannotResolveOrApplyContextWindow(form: HubCatEditorFormState): boolean | null {
  if (form.acpEnabled) return false;
  if (form.clientId === 'antigravity' || form.clientId === 'catagent' || form.clientId === 'google') return true;
  if (form.clientId !== 'openai') return false;
  if (form.codexCarrier === 'app_server') return true;
  if (form.codexCarrier === 'exec_json') return false;
  return null;
}

function ContextWindowCompatibilityNotice({ cat, form }: { cat?: CatData | null; form: HubCatEditorFormState }) {
  const usesSavedContext = selectionMatchesSavedContext(cat, form);
  const capability = usesSavedContext ? cat?.resolvedContext : null;
  const projectedIncompatibility =
    capability?.reportsRuntimeWindow === false && capability.nativeWindowControl === false
      ? true
      : capability?.reportsRuntimeWindow === true || capability?.nativeWindowControl === true
        ? false
        : null;
  const cannotResolveOrApply = projectedIncompatibility ?? draftCannotResolveOrApplyContextWindow(form);
  if (cannotResolveOrApply !== true) return null;

  const manualWindow = Number(form.contextWindow.trim());
  const isManual = Number.isInteger(manualWindow) && manualWindow > 0;
  const hasCurrentAutoResolution =
    !isManual &&
    usesSavedContext &&
    cat?.contextWindow == null &&
    cat?.defaultModel === form.defaultModel &&
    (capability?.source === 'reported' || capability?.source === 'catalog');
  const hasCatalogAutoResolution = !isManual && getContextWindowFallback(form.defaultModel) != null;
  if (hasCurrentAutoResolution || hasCatalogAutoResolution) return null;

  return (
    <output
      id="context-window-compat-notice"
      className="block rounded-[10px] border border-conn-amber-ring bg-conn-amber-bg px-3 py-2 text-xs leading-5 text-conn-amber-text"
    >
      {isManual
        ? '当前 Client 无法校验或调整自身的上下文窗口；请确认 Manual 值不高于 Client 的实际上限。'
        : '当前 Client 无法自动探测上下文窗口；请填写正整数使用 Manual 模式。'}
    </output>
  );
}
