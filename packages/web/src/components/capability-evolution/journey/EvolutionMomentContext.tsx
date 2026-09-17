import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import {
  blockerLabel,
  type EvolutionProgramPresentationProjection,
  productStatus,
} from '../capability-evolution-presentation';
import { type JourneyMoment, journeyMoment, MOMENTS } from '../EvolutionJourney';
import { JourneyFace, LifecycleStatusFace, SetupFace } from '../EvolutionProgramContext';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { useEvolutionPreparationReview } from '../evolution-preparation-resource';
import { EvolutionExplorationWorkspace } from '../exploration/EvolutionExplorationWorkspace';
import { EvolutionPreparationWorkspace } from '../preparation/EvolutionPreparationWorkspace';
import { EvolutionPreparationMaterials } from './EvolutionPreparationMaterials';

function PublishedMaterials({
  projection,
  mode,
  onSelectCandidate,
}: {
  projection: EvolutionProgramPresentationProjection;
  mode: 'preparation' | 'candidates';
  onSelectCandidate?: (version: ExactAssetVersionRefV1) => void;
}) {
  const publication = useEvolutionPreparationReview(projection);
  return (
    <EvolutionPreparationMaterials
      review={publication.review}
      loading={publication.loading}
      error={publication.error}
      retry={publication.retry}
      mode={mode}
      onSelectCandidate={onSelectCandidate}
    />
  );
}

function Goal({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const { certificates } = projection.program;
  return (
    <>
      <h2 className="text-lg font-semibold text-cafe">目标与评估约定</h2>
      <p className="evolution-empty mt-2">先明确想改进什么、怎样判断有效，以及值得投入多少。</p>
      <dl className="mt-4 space-y-4">
        {(
          [
            ['goal', '改进目标'],
            ['measurement', '评估方式'],
            ['economic', '投入边界'],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <dt className="text-sm font-semibold text-cafe">{label}</dt>
            <dd className="evolution-empty mt-1">{certificates[key] ? '已确认，约定保存在来源中。' : '尚待确认。'}</dd>
            {certificates[key] && <EvolutionSource label={`${label}来源`} source={certificates[key]} />}
          </div>
        ))}
      </dl>
      {projection.program.lifecycle === 'active' && projection.program.stage === 'constituting' && (
        <SetupFace projection={projection} />
      )}
    </>
  );
}

function PreparationEvidence({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const observation = projection.observation;
  return (
    <>
      <p className="evolution-empty mt-3">
        {projection.program.stage === 'constituting'
          ? '这些是相关来源，不替代目标与评估约定。'
          : observation?.status === 'connected'
            ? '评估来源已接通，是否有效仍以独立评估结果为准。'
            : '证据尚未齐备，目前不能判断改进是否有效。'}
      </p>
      <PublishedMaterials projection={projection} mode="preparation" />
      <h3 className="mt-5 text-sm font-semibold text-cafe">已接入的反馈</h3>
      {observation?.connectedEyes.length ? (
        <ul className="mt-2 space-y-2">
          {observation.connectedEyes.map((eye) => (
            <li key={`${eye.sourceKind}:${eye.ownerSurfaceRef.ownerStateRef}`}>
              <EvolutionSource label="反馈来源" source={eye.ownerSurfaceRef} href={eye.ownerHref} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="evolution-empty mt-2">{observation ? '尚未接入可核验的反馈。' : '反馈来源尚待确认。'}</p>
      )}
      {observation && observation.gaps.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold text-cafe">还需要</h3>
          <ul className="mt-2 space-y-2 text-sm text-cafe-secondary">
            {observation.gaps.map((gap) => (
              <li key={`${gap.code}:${gap.ownerStateRef ?? gap.ownerFeatureId}`}>{blockerLabel(gap.code)}</li>
            ))}
          </ul>
        </>
      )}
      <h3 className="mt-5 text-sm font-semibold text-cafe">下次评估</h3>
      <p className="evolution-empty mt-2">
        {observation?.nextEvaluationAt ? (
          <time dateTime={observation.nextEvaluationAt}>
            {new Date(observation.nextEvaluationAt).toLocaleString('zh-CN')}
          </time>
        ) : (
          '评估时间尚待确认。'
        )}
      </p>
    </>
  );
}

function hasPreparationEntries(projection: EvolutionProgramPresentationProjection): boolean {
  return Object.values(projection.preparation?.sections ?? {}).some(
    (section) => section.current !== null || section.history.length > 0 || section.activities.length > 0,
  );
}

function Preparation({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  return (
    <>
      <EvolutionPreparationWorkspace projection={projection} />
      {hasPreparationEntries(projection) ? (
        <details className="evolution-preparation-related">
          <summary>Owner 已发布的实验材料与观测接入</summary>
          <PreparationEvidence projection={projection} />
        </details>
      ) : (
        <section className="evolution-preparation-related" aria-label="Owner 已发布的实验材料与观测接入">
          <PreparationEvidence projection={projection} />
        </section>
      )}
    </>
  );
}

/** Viewing a moment never mutates stage, approvals, evidence, or adoption. */
export function EvolutionMomentContext({
  projection,
  moment,
  children,
  onSelectCandidate,
  onOpenPreparation,
  explorationMode = 'summary',
}: {
  projection: EvolutionProgramPresentationProjection;
  moment: JourneyMoment;
  children?: ReactNode;
  onSelectCandidate?: (version: ExactAssetVersionRefV1) => void;
  onOpenPreparation?: () => void;
  explorationMode?: 'summary' | 'workspace';
}) {
  const current = journeyMoment(projection);
  return (
    <section data-journey-panel={moment} aria-label={MOMENTS[moment]} className="space-y-4">
      {productStatus(projection).face === 'lifecycle' && <LifecycleStatusFace projection={projection} />}
      {projection.program.lifecycle === 'terminal' && <JourneyFace projection={projection} />}
      {moment > current && moment !== 2 && projection.program.lifecycle !== 'terminal' && (
        <p className="evolution-empty">项目目前在{productStatus(projection).label}，这里展示后续需要完成的内容。</p>
      )}
      {moment === 0 ? (
        <Goal projection={projection} />
      ) : moment === 1 ? (
        <Preparation projection={projection} />
      ) : moment === 2 ? (
        <>
          <EvolutionExplorationWorkspace
            projection={projection}
            mode={explorationMode}
            onPreparation={onOpenPreparation}
          />
          <details className="evolution-preparation-related">
            <summary>准备阶段的公开候选与取舍</summary>
            <PublishedMaterials projection={projection} mode="candidates" onSelectCandidate={onSelectCandidate} />
          </details>
        </>
      ) : (
        <p className="evolution-empty">采用后的后续任务是否真的使用了这个版本，要看对应的使用回执。</p>
      )}
      {children}
    </section>
  );
}
