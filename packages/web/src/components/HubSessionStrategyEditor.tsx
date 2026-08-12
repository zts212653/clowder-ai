'use client';

import { SESSION_STRATEGY_OPTIONS, type StrategyFormState } from './hub-cat-editor.model';
import { RangeField, SelectField, TextField } from './hub-cat-editor-fields';
import { SOURCE_LABELS } from './hub-strategy-types';

const REASON_LABELS: Record<string, string> = {
  managed_invocation_boundary: '需要受管 invocation 边界',
  effective_input_ceiling: '缺少有效输入上限',
  carrier_binding: '缺少当前 carrier 绑定',
  authoritative_usage: '缺少权威 usage',
  session_rotation: '缺少 Session 轮换能力',
  continuity_bootstrap: '缺少连续性重建能力',
  compression_signal: '缺少压缩事件信号',
};

function statusLabel(status: StrategyFormState['executionStatus']['status']): string {
  if (status === 'active') return 'Active';
  if (status === 'degraded') return 'Degraded';
  return 'Unavailable';
}

export function HubSessionStrategyEditor({
  strategyForm,
  loading,
  error,
  onChange,
}: {
  strategyForm: StrategyFormState | null;
  loading: boolean;
  error: string | null;
  onChange: (patch: Partial<StrategyFormState>) => void;
}) {
  const statusMatchesDraft = strategyForm?.strategy === strategyForm?.statusStrategy;

  return (
    <div className="space-y-3 rounded-[14px] bg-[var(--console-runtime-group-bg)] p-[14px]">
      {loading ? <p className="text-sm text-cafe-secondary">Session 策略加载中...</p> : null}
      {error ? (
        <p className="rounded-[20px] border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">
          {error}
        </p>
      ) : null}
      {strategyForm ? (
        <div className="space-y-4">
          <div className="rounded-[10px] bg-[var(--console-runtime-field-bg)] px-4 py-3 text-xs leading-5 text-[var(--console-runtime-hint)]">
            <p className="font-semibold text-cafe">Session State / Chain 始终记录并可见。</p>
            <p>策略只表达你的意图；能力不足会显示执行状态，不会把策略静默改成另一种。</p>
            <p>保存后的策略从下一次 invocation 起作用于当前 active session；正在运行的 invocation 保持原快照。</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-[var(--console-field-bg)] px-2.5 py-1 font-semibold text-cafe-secondary">
              {statusMatchesDraft ? '能力预检' : `已保存 ${strategyForm.statusStrategy} 策略的能力预检`}：
              {statusLabel(strategyForm.executionStatus.status)}
            </span>
            <span className="text-cafe-muted">来源：{SOURCE_LABELS[strategyForm.source] ?? strategyForm.source}</span>
          </div>
          {!statusMatchesDraft ? (
            <p className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2 text-xs leading-5 text-[var(--cafe-accent)]">
              保存后会重新预检 {strategyForm.strategy}；当前状态不会被套用到未保存的策略。
            </p>
          ) : strategyForm.executionStatus.missingCapabilities.length > 0 ? (
            <p className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2 text-xs leading-5 text-[var(--cafe-accent)]">
              {strategyForm.executionStatus.missingCapabilities
                .map((reason) => REASON_LABELS[reason] ?? reason)
                .join('；')}
            </p>
          ) : null}

          <div className="space-y-2">
            <SelectField
              label="Session Strategy"
              value={strategyForm.strategy}
              options={SESSION_STRATEGY_OPTIONS}
              onChange={(value) => onChange({ strategy: value as StrategyFormState['strategy'] })}
              tone="success"
            />
            <RangeField
              label={strategyForm.strategy === 'compress' ? 'Session Observe Threshold' : 'Session Warn Threshold'}
              value={strategyForm.warnThreshold}
              onChange={(value) => onChange({ warnThreshold: value })}
              hint={
                strategyForm.strategy === 'compress'
                  ? '仅用于观测；compress 不触发 handoff'
                  : 'context 填充到此比例时发出警告'
              }
            />
            <RangeField
              label={
                strategyForm.strategy === 'compress' ? 'Session Observe Threshold (upper)' : 'Session Action Threshold'
              }
              value={strategyForm.actionThreshold}
              onChange={(value) => onChange({ actionThreshold: value })}
              hint={
                strategyForm.strategy === 'compress'
                  ? '仅用于观测；Session 在 client 压缩后继续存活'
                  : '能力状态为 Active 时，达到此比例才执行当前策略动作'
              }
            />
            {strategyForm.strategy === 'hybrid' ? (
              <TextField
                label="Max Compressions"
                value={strategyForm.maxCompressions}
                onChange={(value) => onChange({ maxCompressions: value })}
                inputMode="numeric"
                tone="success"
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
