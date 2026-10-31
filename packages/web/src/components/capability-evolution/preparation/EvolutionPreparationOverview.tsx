import { EVOLUTION_PREPARATION_SECTIONS, type EvolutionPreparationSection } from '@cat-cafe/shared';
import { useCatData } from '@/hooks/useCatData';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { EvolutionPreparationSectionIcon } from './EvolutionPreparationSectionIcon';
import {
  type EvolutionPreparationSectionProjection,
  isVisiblePreparationSubmission,
} from './evolution-preparation-resource';
import {
  preparationBodySummary,
  preparationBoundarySummary,
  SECTION_META,
  sectionState,
} from './preparation-section-presentation';

export function EvolutionPreparationOverview({
  projection,
  onOpen,
}: {
  projection: EvolutionProgramProjection;
  onOpen: (section: EvolutionPreparationSection) => void;
}) {
  const sections = projection.preparation?.sections;
  return (
    <section className="evolution-v2-preparation" aria-label="准备四块总览">
      <div className="evolution-v2-preparation-grid">
        {EVOLUTION_PREPARATION_SECTIONS.map((key) => {
          const section = sections?.[key];
          const meta = SECTION_META[key];
          const current = section?.current;
          const body = isVisiblePreparationSubmission(current) ? current.submission.body : undefined;
          const state = section ? sectionState(section) : { key: 'unavailable', label: '尚未提供' };
          return (
            <button
              type="button"
              key={key}
              className="evolution-v2-preparation-card"
              data-preparation-category={meta.category}
              data-preparation-overview={key}
              onClick={() => onOpen(key)}
            >
              <span className="evolution-v2-preparation-heading">
                <EvolutionPreparationSectionIcon section={key} />
                <span>
                  <strong>{meta.label}</strong>
                  <small>{meta.hint}</small>
                </span>
              </span>
              <span className="evolution-v2-preparation-state">
                {state.label}
                {body && <small>草案 · 不等于验证</small>}
              </span>
              <span>
                {body ? preparationBodySummary(body, current ?? undefined) : '内容待来源提供，可展开查看已有记录。'}
              </span>
              {body && preparationBoundarySummary(body) && <small>{preparationBoundarySummary(body)}</small>}
            </button>
          );
        })}
      </div>
      <EvolutionPreparationActivityStatus projection={projection} />
    </section>
  );
}

export function EvolutionPreparationActivityStatus({
  projection,
  section,
}: {
  projection: EvolutionProgramProjection;
  section?: EvolutionPreparationSectionProjection;
}) {
  const { getCatById } = useCatData();
  const sections = projection.preparation?.sections;
  const readingSections = section ? [section] : Object.values(sections ?? {});
  const active = readingSections.some((entry) => entry.activities.some((activity) => activity.state === 'active'));
  const recent = section?.activities.find(
    (activity) => !activity.itemId && activity.state !== 'superseded_by_submission',
  );
  const cat = recent?.catId ? getCatById(recent.catId) : undefined;
  return (
    <p className="evolution-v2-activity" role="status">
      <strong>{active ? '猫正在准备' : '活动状态待核实'}</strong>{' '}
      {recent && (
        <span>
          · 最近记录的工作：{recent.focus}（{cat ? cat.nickname?.trim() || cat.displayName : '作者信息待核实'}）。{' '}
        </span>
      )}
      {active ? '已看到本轮活动记录；工作进展与可改边界分别阅读。' : '未见可核验的进行中活动，已有提交仍可阅读。'}
    </p>
  );
}
