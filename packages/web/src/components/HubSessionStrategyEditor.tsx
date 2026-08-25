'use client';

import { SESSION_STRATEGY_OPTIONS, type StrategyFormState } from './hub-cat-editor.model';
import { RangeField, SelectField, TextField } from './hub-cat-editor-fields';

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
  return (
    <section className="space-y-3 rounded-[14px] bg-[var(--console-runtime-group-bg)] p-[14px]">
      <h5 className="text-sm font-semibold text-cafe">Session State / Chain</h5>
      {loading ? <p className="text-sm text-cafe-secondary">Session 策略加载中...</p> : null}
      {error ? (
        <p className="rounded-[20px] border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">
          {error}
        </p>
      ) : null}
      {strategyForm ? (
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
      ) : null}
    </section>
  );
}
