import type { EvolutionProgramProjection } from './evolution-program-projection';
import { DEFAULT_READING, type EvolutionReading, useEvolutionReading } from './evolution-reading-state';

export const MOMENTS = ['提出目标', '准备', '探索进化', '后续沿用'] as const;
export type JourneyMoment = NonNullable<EvolutionReading['journeyMoment']>;
export function journeyMoment(projection: EvolutionProgramProjection): JourneyMoment {
  const { stage, lifecycle, terminalDisposition } = projection.program;
  if (lifecycle === 'terminal') return terminalDisposition === 'kept' ? 3 : 2;
  if (stage === 'constituting') return 0;
  if (stage === 'writing_back' || stage === 'revalidating') return 3;
  if (stage === 'awaiting_approval' || stage === 'deciding') return 2;
  return 1;
}

export function EvolutionJourney({ projection }: { projection: EvolutionProgramProjection }) {
  const current = journeyMoment(projection);
  const id = projection.program.programId;
  const reading = useEvolutionReading((state) => state.programs[id] ?? DEFAULT_READING);
  const update = useEvolutionReading((state) => state.update);
  const selected = reading.journeyMoment ?? current;
  return (
    <nav className="evolution-journey" aria-label="能力进化旅程">
      <ol className="evolution-journey-steps">
        {MOMENTS.map((moment, index) => (
          <li key={moment} aria-current={index === current ? 'step' : undefined}>
            {index > 0 && (
              <span className="evolution-journey-arrow" aria-hidden="true">
                →
              </span>
            )}
            <button
              type="button"
              aria-pressed={index === selected}
              onClick={() => update(id, { journeyMoment: index as JourneyMoment, view: 'judgment' })}
            >
              {moment}
            </button>
          </li>
        ))}
      </ol>
      <p className="evolution-journey-progress">当前进度：{MOMENTS[current]} · 点击查看各阶段</p>
    </nav>
  );
}
