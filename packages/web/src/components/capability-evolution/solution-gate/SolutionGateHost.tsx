'use client';
import { useEffect, useState } from 'react';
import { EvolutionProgramSurface as ProductSurface } from '../EvolutionProgramSurface';
import { DuckEvolutionDemo } from './duck-demo/DuckEvolutionDemo';
import { SolutionLineageGate } from './SolutionLineageGate';
import { SOLUTION_PREVIEW_ID } from './solution-example';

/** Opt-in development candidate in the real owner renderer; never a production Program replacement. */
export function EvolutionProgramSurface({ programId }: { programId: string }) {
  const [gate, setGate] = useState(false);
  const [duckDemo, setDuckDemo] = useState(false);
  const [mockExploration, setMockExploration] = useState(false);
  useEffect(() => {
    setMockExploration(
      process.env.NODE_ENV !== 'production' &&
        programId === SOLUTION_PREVIEW_ID &&
        new URLSearchParams(window.location.search).get('mockExploration') === '1',
    );
    setDuckDemo(new URLSearchParams(window.location.search).get('duckDemo') === '1');
    setGate(
      process.env.NODE_ENV !== 'production' &&
        programId === SOLUTION_PREVIEW_ID &&
        new URLSearchParams(window.location.search).get('solutionGate') === '1',
    );
  }, [programId]);
  if (mockExploration && programId === SOLUTION_PREVIEW_ID)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="mock-exploration-host">
        <aside className="border-b border-cafe-subtle bg-cafe-surface p-3 text-xs text-cafe-secondary">
          模拟项目 · 以下复用正式探索进化页面；数据、版本和成绩全部为 mock。发送、训练和采用不会执行真实动作。
        </aside>
        <ProductSurface programId={programId} />
      </div>
    );
  return gate && programId === SOLUTION_PREVIEW_ID ? (
    duckDemo ? (
      <DuckEvolutionDemo />
    ) : (
      <SolutionLineageGate />
    )
  ) : (
    <ProductSurface programId={programId} />
  );
}
