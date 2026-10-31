import type { TrajectoryResolutionError } from './canonical-trajectory-resolution';
import { trajectoryCopy } from './trajectory.shell-copy';
import type { TrajectoryTarget } from './trajectory-navigation';
import { useTrajectoryCopy } from './use-trajectory-copy';

export function TrajectoryResolutionFailure({
  target,
  error,
  onRetry,
  onBack,
}: {
  target: TrajectoryTarget;
  error: TrajectoryResolutionError;
  onRetry: () => void;
  onBack: () => void;
}) {
  const t = useTrajectoryCopy(trajectoryCopy);
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-cafe-muted"
      data-testid="trajectory-resolution-error"
      data-error-code={error.code}
    >
      <p>{error.status === 403 ? t.accessDenied : error.status === 409 ? t.coordinateMismatch : t.targetUnavailable}</p>
      <code className="font-mono text-xs">inv:{target.invocationId}</code>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-lg border border-cafe px-3 py-2 font-semibold text-cafe-secondary"
          onClick={onRetry}
        >
          {t.retry}
        </button>
        <button
          type="button"
          className="rounded-lg border border-cafe px-3 py-2 font-semibold text-cafe-secondary"
          onClick={onBack}
        >
          {t.backSource}
        </button>
      </div>
    </div>
  );
}

export function TrajectoryResolutionLoading({ switchingThread }: { switchingThread: boolean }) {
  const t = useTrajectoryCopy(trajectoryCopy);
  return (
    <div
      className="flex h-full items-center justify-center p-4 text-sm text-cafe-muted"
      data-testid="trajectory-direct-open"
    >
      {switchingThread ? t.switchingThread : t.locatingRun}
    </div>
  );
}
