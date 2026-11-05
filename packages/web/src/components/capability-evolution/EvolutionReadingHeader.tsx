import type { ReactNode } from 'react';
import { evolutionProgramPresentation, productStatus } from './capability-evolution-presentation';
import { EvolutionJourney, type JourneyMoment, journeyStageLabel } from './EvolutionJourney';
import { EvolutionProgramName } from './EvolutionProgramName';
import { EvolutionProgramOrigin } from './EvolutionProgramOrigin';
import type { EvolutionProgramProjection } from './evolution-program-projection';
import { EvolutionProgressAction } from './journey/EvolutionProgressAction';

function readingReturnLabel(desktop: boolean, fullWindow: boolean): string {
  if (fullWindow) return '← 回到聊天';
  return desktop ? '← 返回侧栏' : '← 返回详情';
}

export function EvolutionReadingHeader({
  projection,
  controls,
  returnToRail,
  desktop,
  fullWindow,
  moment,
  v2,
}: {
  projection: EvolutionProgramProjection;
  controls: ReactNode;
  returnToRail: () => void;
  desktop: boolean;
  fullWindow: boolean;
  moment: JourneyMoment;
  v2: boolean;
}) {
  const status = productStatus(projection);
  const returnLabel = readingReturnLabel(desktop, fullWindow);
  if (!v2 || (moment !== 1 && moment !== 2))
    return (
      <header>
        <div className="mb-6 flex items-center justify-between">
          <button type="button" className="text-xs text-cafe-secondary" onClick={returnToRail}>
            {returnLabel}
          </button>
          {controls}
        </div>
        <p className={moment === 2 ? 'sr-only' : 'evolution-eyebrow'}>
          能力进化 · 第 {projection.program.cycle} 轮 · {status.label}
        </p>
        <h1 className="evolution-title mt-2">
          {evolutionProgramPresentation(projection.program, projection.origin).title}
        </h1>
        {moment === 2 ? (
          <details className="exploration-project-context">
            <summary>项目详情与推进</summary>
            <p>
              第 {projection.program.cycle} 轮 · {status.label}
            </p>
            <EvolutionProgramOrigin projection={projection} />
            <EvolutionProgramName projection={projection} />
            <EvolutionProgressAction projection={projection} compact />
            <EvolutionJourney projection={projection} />
          </details>
        ) : (
          <>
            <EvolutionProgramOrigin projection={projection} />
            <EvolutionProgramName projection={projection} />
          </>
        )}
        {moment !== 2 && <EvolutionJourney projection={projection} />}
      </header>
    );
  return (
    <header className="evolution-v2-reading-heading">
      <div className="evolution-v2-reading-toolbar">
        <button type="button" className="evolution-link" onClick={returnToRail}>
          {returnLabel}
        </button>
        {controls}
      </div>
      <p className="evolution-eyebrow">
        能力进化 · 第 {projection.program.cycle} 轮 · {journeyStageLabel(projection)}
      </p>
      <h1 className="evolution-title">{evolutionProgramPresentation(projection.program, projection.origin).title}</h1>
      <div className="evolution-v2-reading-origin">
        <EvolutionProgramOrigin projection={projection} />
        <EvolutionProgramName projection={projection} />
      </div>
      <EvolutionJourney projection={projection} />
      <details className="evolution-v2-project-progress">
        <summary>项目推进</summary>
        <EvolutionProgressAction projection={projection} compact />
      </details>
    </header>
  );
}
