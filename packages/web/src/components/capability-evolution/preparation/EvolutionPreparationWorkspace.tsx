'use client';

import {
  EVOLUTION_PREPARATION_SECTIONS,
  type EvolutionPreparationSection as PreparationSection,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useRef } from 'react';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { DEFAULT_READING, useEvolutionReading } from '../evolution-reading-state';
import { EvolutionPreparationSection } from './EvolutionPreparationSection';
import { EvolutionPreparationSectionIcon } from './EvolutionPreparationSectionIcon';
import {
  type EvolutionPreparationSectionProjection,
  isVisiblePreparationSubmission,
} from './evolution-preparation-resource';

const SECTION_META: Record<
  PreparationSection,
  { label: string; hint: string; category: 'object' | 'rubric' | 'measurement' | 'diagnosis' }
> = {
  object_map: { label: '可进化对象', hint: '范围与可改边界', category: 'object' },
  success_contract: { label: '好坏规约', hint: '判法、反例与裁判', category: 'rubric' },
  measurement_plan: { label: '测量与实验准备', hint: 'GT 来源与实验条件', category: 'measurement' },
  baseline_diagnosis: { label: '基线与初步诊断', hint: '事实、未知与竞争解释', category: 'diagnosis' },
};

function latestOpenActivity(section: EvolutionPreparationSectionProjection) {
  return section.activities.find((activity) => activity.state !== 'superseded_by_submission');
}

function sectionState(section: EvolutionPreparationSectionProjection) {
  const status = section.current?.status;
  if (status === 'submitted') return { key: status, label: '已提交' };
  if (status === 'needs_update') return { key: status, label: '需更新' };
  if (status === 'materializing') return { key: status, label: '需恢复' };
  if (status === 'source_unavailable' || status === 'source_invalid') return { key: status, label: '需处理' };
  const activity = latestOpenActivity(section);
  if (activity?.state === 'active') return { key: 'working', label: '正在进行' };
  if (activity?.state === 'terminal') return { key: 'terminal', label: '运行已结束' };
  if (activity) return { key: activity.state, label: '活动待核实' };
  return { key: 'not_started', label: '待猫继续准备' };
}

function gtLabels(projection: EvolutionProgramProjection): Readonly<Record<string, string>> {
  const measurement = projection.preparation?.sections.measurement_plan.current;
  if (!isVisiblePreparationSubmission(measurement) || measurement.submission.body.kind !== 'measurement_plan')
    return {};
  return Object.fromEntries(measurement.submission.body.gtSources.map((source) => [source.sourceKey, source.label]));
}

function readableTarget(ownerStateRef: string): string {
  if (!ownerStateRef.startsWith('capability:')) return ownerStateRef;
  try {
    return decodeURIComponent(ownerStateRef.slice('capability:'.length));
  } catch {
    return ownerStateRef;
  }
}

export function EvolutionPreparationWorkspace({ projection }: { projection: EvolutionProgramProjection }) {
  const workspace = useRef<HTMLElement>(null);
  const programId = projection.program.programId;
  const reading = useEvolutionReading((state) => state.programs[programId] ?? DEFAULT_READING);
  const update = useEvolutionReading((state) => state.update);
  const selected = reading.preparationSection ?? 'object_map';
  const preparation = projection.preparation;
  const labels = useMemo(() => gtLabels(projection), [projection]);

  useEffect(() => {
    const target =
      selected === 'measurement_plan' && reading.preparationGtSourceKey
        ? [...(workspace.current?.querySelectorAll<HTMLElement>('[data-gt-source-key]') ?? [])].find(
            (node) => node.dataset.gtSourceKey === reading.preparationGtSourceKey,
          )
        : selected === 'success_contract' && reading.preparationReturn
          ? [...(workspace.current?.querySelectorAll<HTMLElement>('[data-preparation-criterion]') ?? [])]
              .find(
                (node) =>
                  node.dataset.preparationCriterion === reading.preparationReturn?.criterionId &&
                  node.dataset.preparationRevision === reading.preparationReturn?.revision,
              )
              ?.querySelector<HTMLElement>('summary')
          : undefined;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest' });
  }, [reading.preparationReturn, reading.preparationGtSourceKey, selected]);

  const selectSection = (section: PreparationSection) =>
    update(programId, {
      preparationSection: section,
      ...(section === 'measurement_plan' ? { preparationReturn: undefined, preparationGtSourceKey: undefined } : {}),
      ...(section === 'measurement_plan' ? {} : { preparationGtSourceKey: undefined }),
    });
  const jumpToGtSource = (sourceKey: string, criterionId: string, revision: string) => {
    const keys = reading.preparationOpenDetails ?? [];
    const key = `${revision}:criterion:${criterionId}`;
    update(programId, {
      preparationSection: 'measurement_plan',
      preparationGtSourceKey: sourceKey,
      preparationReturn: { criterionId, revision },
      preparationOpenDetails: [...new Set([...keys, key, 'success_contract:history', `${revision}:history`])].slice(
        -128,
      ),
    });
  };
  const returnSubmission =
    preparation &&
    [preparation.sections.success_contract.current, ...preparation.sections.success_contract.history].find(
      (value) => value?.ref.version === reading.preparationReturn?.revision,
    );
  const returnBody = returnSubmission?.submission?.body;
  const returnCriterion =
    returnBody?.kind === 'success_contract'
      ? returnBody.criteria.find((criterion) => criterion.criterionId === reading.preparationReturn?.criterionId)
      : undefined;
  const measurement = preparation?.sections.measurement_plan;
  const followsRubric = selected === 'measurement_plan' && Boolean(reading.preparationReturn);
  const matchedMeasurement =
    measurement &&
    [measurement.current, ...measurement.history].find((value) =>
      value?.dependencies.some(
        (ref) =>
          ref.ownerStateRef === `preparation-submission:${programId}:success_contract` &&
          ref.version === reading.preparationReturn?.revision,
      ),
    );
  const selectedSection = preparation?.sections[selected];
  const measurementHistory = followsRubric && matchedMeasurement?.ref.version !== measurement?.current?.ref.version;
  const displayedSection =
    followsRubric && selectedSection && matchedMeasurement
      ? { ...selectedSection, current: matchedMeasurement, history: [], activities: [] }
      : selectedSection;

  return (
    <section
      ref={workspace}
      className="evolution-preparation"
      data-testid="evolution-preparation-workspace"
      data-active-section={selected}
      aria-label="准备工作面"
    >
      <header className="evolution-preparation-heading">
        <div>
          <span className="evolution-preparation-kicker">Program 内的可回读准备记录</span>
          <h2>准备</h2>
        </div>
        <p>四块可以交叉推进。提交只表示草案已登记，不代表验证、授权或效果已经成立。</p>
        <p className="evolution-source">
          当前 Program 只绑定一个 target：{projection.program.objectRef.ownerFeatureId} ·{' '}
          {readableTarget(projection.program.objectRef.ownerStateRef)}
          {projection.program.objectRef.version ? ` · ${projection.program.objectRef.version}` : ''}
          。候选地图不会改写此绑定。
        </p>
      </header>
      <div role="tablist" aria-label="准备阅读入口" className="evolution-preparation-tabs">
        {EVOLUTION_PREPARATION_SECTIONS.map((section) => {
          const meta = SECTION_META[section];
          const activity = preparation && latestOpenActivity(preparation.sections[section]);
          const state = preparation
            ? sectionState(preparation.sections[section])
            : { key: 'unavailable', label: '尚未提供' };
          return (
            <button
              key={section}
              type="button"
              role="tab"
              aria-selected={selected === section}
              aria-controls={`evolution-preparation-panel-${section}`}
              data-preparation-section={section}
              data-preparation-category={meta.category}
              onClick={() => selectSection(section)}
            >
              <span className="evolution-preparation-tab-heading">
                <span className="evolution-preparation-tab-icon" data-preparation-section-icon>
                  <EvolutionPreparationSectionIcon section={section} />
                </span>
                <span className="evolution-preparation-tab-copy">
                  <span className="evolution-preparation-tab-label">{meta.label}</span>
                  <span className="evolution-preparation-tab-hint" data-preparation-category-hint>
                    {meta.hint}
                  </span>
                </span>
              </span>
              {activity?.state === 'active' && state.key !== 'working' && (
                <small data-preparation-section-state="working">猫正在准备</small>
              )}
              <small data-preparation-section-state={state.key}>{state.label}</small>
            </button>
          );
        })}
      </div>
      {selected === 'measurement_plan' && reading.preparationReturn && (
        <div className="evolution-preparation-return">
          <button type="button" className="evolution-link" onClick={() => selectSection('success_contract')}>
            返回规约：{returnCriterion?.label ?? '原规约来源不可用'}
          </button>
          {!labels[reading.preparationGtSourceKey ?? ''] && (
            <p role="status">来源缺失或不可读，暂时无法判定；原规约仍保留。</p>
          )}
        </div>
      )}
      {selected === 'baseline_diagnosis' && (
        <button type="button" className="evolution-link" onClick={() => selectSection('object_map')}>
          回到可进化对象
        </button>
      )}
      <div
        id={`evolution-preparation-panel-${selected}`}
        role="tabpanel"
        className="evolution-preparation-panel"
        data-preparation-panel-section={selected}
      >
        {!preparation ? (
          <div className="evolution-preparation-empty">
            <h3>准备记录尚未提供</h3>
            <p>当前 owner read model 没有返回准备投影；页面不会用本地样例或缓存补造一份。</p>
          </div>
        ) : followsRubric && !matchedMeasurement ? (
          <div className="evolution-preparation-empty" role="status">
            <p>未找到对应这版规约的取证稿；规约仍保留，不能借用同名的新来源。</p>
            <button type="button" className="evolution-link" onClick={() => selectSection('measurement_plan')}>
              查看当前测量准备
            </button>
          </div>
        ) : (
          <EvolutionPreparationSection
            programId={programId}
            section={displayedSection!}
            historicalCurrent={measurementHistory}
            gtLabels={labels}
            focusedGtSourceKey={reading.preparationGtSourceKey}
            onJumpGtSource={jumpToGtSource}
          />
        )}
      </div>
    </section>
  );
}
