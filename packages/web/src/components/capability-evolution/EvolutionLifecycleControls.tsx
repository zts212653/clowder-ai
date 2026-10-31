import type { EvolutionProgramProjection } from './evolution-program-projection';
import type { useEvolutionLifecycle } from './use-evolution-lifecycle';

export function EvolutionLifecycleControls({
  projection,
  lifecycle,
}: {
  projection: EvolutionProgramProjection;
  lifecycle: ReturnType<typeof useEvolutionLifecycle>;
}) {
  return (
    <details className="relative text-xs text-cafe-secondary">
      <summary className="cursor-pointer">更多</summary>
      <div className="absolute right-0 top-6 z-10 w-36 rounded-lg border border-cafe-subtle bg-cafe-surface p-2 shadow-sm">
        {projection.program.lifecycle === 'active' && (
          <button
            className="w-full p-2 text-left"
            type="button"
            disabled={lifecycle.pending}
            onClick={() => void lifecycle.run('pause')}
          >
            暂停项目
          </button>
        )}
        {projection.program.lifecycle === 'paused' && (
          <button
            className="w-full p-2 text-left"
            type="button"
            disabled={lifecycle.pending}
            onClick={() => void lifecycle.run('resume')}
          >
            恢复项目
          </button>
        )}
        {projection.program.lifecycle !== 'active' && projection.program.lifecycle !== 'paused' && (
          <p className="p-2">记录已保留</p>
        )}
      </div>
    </details>
  );
}
