'use client';

import type { CatData } from '@/hooks/useCatData';
import { ContextWindowCompatibilityNotice } from '../hub-cat-editor-advanced';
import { RangeField, SectionCard, SelectField, TextField } from '../hub-cat-editor-fields';
import type { HubCatEditorController } from '../useHubCatEditor';
import { useMembersCopy, useMemberText } from './editor-presentation';

export function MemberContextSection({ editor: e, cat }: { editor: HubCatEditorController; cat?: CatData | null }) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const s = e.strategyForm;
  const strategyNames = { handoff: '交接到新会话', compress: '原地压缩', hybrid: '先压缩，再交接' };
  const statusLabels = { active: t('可用'), degraded: copy.contextDegraded, unavailable: t('不可用') };
  return (
    <SectionCard title={t('上下文')}>
      <TextField
        label={t('上下文窗口')}
        ariaLabel="Context Window"
        value={e.form.contextWindow}
        onChange={(value) => e.patchForm({ contextWindow: value })}
        inputMode="numeric"
        placeholder={t('留空或 0：自动探测')}
      />
      <p>{t('填写正整数指定窗口大小；留空或填 0，由运行时自动探测。')}</p>
      <ContextWindowCompatibilityNotice cat={cat} form={e.form} />
      {e.loadingStrategy && <output>{t('正在读取上下文设置…')}</output>}
      {e.strategyError && <p role="alert">{e.strategyError}</p>}
      {s && (
        <>
          <SelectField
            label={t('会话处理')}
            value={s.strategy}
            options={[
              { value: 'handoff', label: '交接到新会话' },
              { value: 'compress', label: '原地压缩' },
              { value: 'hybrid', label: '先压缩，再交接' },
            ]}
            onChange={(value) => e.patchStrategy({ strategy: value as typeof s.strategy })}
          />
          <RangeField
            label="提醒线"
            value={s.warnThreshold}
            onChange={(value) => e.patchStrategy({ warnThreshold: value })}
            hint={s.strategy === 'compress' ? '只记录上下文使用情况，不触发交接。' : '上下文达到此比例时提醒。'}
          />
          <RangeField
            label={s.strategy === 'compress' ? '记录线' : '交接线'}
            value={s.actionThreshold}
            onChange={(value) => e.patchStrategy({ actionThreshold: value })}
            hint={
              s.strategy === 'compress'
                ? '客户端压缩后，会话继续运行；此线只做记录。'
                : s.strategy === 'hybrid'
                  ? copy.hybridActionHint
                  : '能力可用时，达到此比例执行当前处理方式。'
            }
          />
          {s.strategy === 'hybrid' && (
            <TextField
              label={t('最多压缩次数')}
              value={s.maxCompressions}
              onChange={(value) => e.patchStrategy({ maxCompressions: value })}
              inputMode="numeric"
            />
          )}
          <p data-testid="member-context-status">
            {s.strategy !== s.statusStrategy
              ? copy.contextDraftUnconfirmed
              : copy.contextStatus(t(strategyNames[s.statusStrategy]), statusLabels[s.executionStatus.status])}
          </p>
        </>
      )}
    </SectionCard>
  );
}
