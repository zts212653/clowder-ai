'use client';
import type { HubCatEditorFormState, StrategyFormState } from '../../hub-cat-editor.model';
import { RangeField, SelectField, TextField } from '../../hub-cat-editor-fields';
import type { MemberText } from './MemberRuntimeFields';
export function MemberSessionFields({
  form,
  patch,
  strategy,
  patchStrategy,
  editing,
  t,
}: {
  form: HubCatEditorFormState;
  patch: (value: Partial<HubCatEditorFormState>) => void;
  strategy: StrategyFormState | null | undefined;
  patchStrategy: (value: Partial<StrategyFormState>) => void;
  editing: boolean;
  t: MemberText;
}) {
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('上下文与会话', 'Context & sessions')}</h2>
      <p className="text-sm text-cafe-secondary">
        {t(
          '选择对话接近上下文上限时的处理方式。',
          'Choose what happens as a conversation approaches its context limit.',
        )}
      </p>
      {strategy ? (
        <>
          <SelectField
            label={t('会话策略', 'Session strategy')}
            value={strategy.strategy}
            options={[
              { value: 'handoff', label: t('交接到新会话', 'Handoff to a new session') },
              { value: 'compress', label: t('压缩并继续当前会话', 'Compress and continue') },
              { value: 'hybrid', label: t('先压缩，再交接', 'Compress, then hand off') },
            ]}
            onChange={(value) => patchStrategy({ strategy: value as StrategyFormState['strategy'] })}
          />
          {strategy.strategy === 'compress' && (
            <p className="text-sm text-cafe-secondary">
              {t(
                '压缩由工具管理，下面的阈值仅用于观测。',
                'The tool manages compression; the thresholds below are for observation.',
              )}
            </p>
          )}
          <details className="rounded-xl border border-[var(--console-border-soft)] p-4">
            <summary className="cursor-pointer text-sm">
              {t('调整阈值', 'Adjust thresholds')} · {Math.round(Number(strategy.warnThreshold) * 100)}% /{' '}
              {Math.round(Number(strategy.actionThreshold) * 100)}%
            </summary>
            <div className="mt-4 space-y-5">
              <RangeField
                label={
                  strategy.strategy === 'compress'
                    ? t('观测阈值', 'Observation threshold')
                    : t('提醒阈值', 'Warning threshold')
                }
                value={strategy.warnThreshold}
                onChange={(warnThreshold) => patchStrategy({ warnThreshold })}
                hint={t('上下文达到此比例时提醒。', 'Notify at this context usage.')}
              />
              <RangeField
                label={
                  strategy.strategy === 'compress'
                    ? t('观测上限', 'Upper observation threshold')
                    : t('执行阈值', 'Action threshold')
                }
                value={strategy.actionThreshold}
                onChange={(actionThreshold) => patchStrategy({ actionThreshold })}
                hint={
                  strategy.strategy === 'compress'
                    ? t('仅观测，不触发交接。', 'Observe only; does not trigger handoff.')
                    : t('达到此比例时执行所选策略。', 'Apply the selected policy at this context usage.')
                }
              />
              {strategy.strategy === 'hybrid' && (
                <TextField
                  label={t('最大压缩次数', 'Maximum compressions')}
                  value={strategy.maxCompressions}
                  onChange={(maxCompressions) => patchStrategy({ maxCompressions })}
                  inputMode="numeric"
                />
              )}
            </div>
          </details>
        </>
      ) : (
        <p className="text-sm text-cafe-secondary">
          {editing
            ? t('会话策略暂不可读取，现有设置保留。', 'Session policy unavailable; current settings are preserved.')
            : t('添加伙伴后可调整会话策略。', 'Session policy is available after adding this teammate.')}
        </p>
      )}
      <details className="rounded-xl border border-[var(--console-border-soft)] p-4">
        <summary className="cursor-pointer text-sm">
          {t('上下文容量', 'Context capacity')} · {form.contextWindow || t('自动', 'Automatic')}
        </summary>
        <div className="mt-4 space-y-2">
          <TextField
            label={t('上限（tokens）', 'Limit (tokens)')}
            value={form.contextWindow}
            onChange={(contextWindow) => patch({ contextWindow })}
            placeholder={t('留空使用默认容量', 'Leave blank for default capacity')}
            inputMode="numeric"
          />
          <p className="text-sm text-cafe-secondary">
            {t('仅在需要指定容量时填写。', 'Set this only when you need a specific capacity.')}
          </p>
        </div>
      </details>
    </div>
  );
}
