import type { TrajectoryResolutionError } from './canonical-trajectory-resolution';
import type { TrajectoryTarget } from './trajectory-navigation';

function errorText(error: TrajectoryResolutionError): string {
  if (error.status === 403) return '没有权限查看这轮 invocation。';
  if (error.status === 409) return '证据坐标与 canonical 记录不一致。';
  return '这轮 invocation 的 canonical 现场暂不可用。';
}

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
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-cafe-muted"
      data-testid="trajectory-resolution-error"
      data-error-code={error.code}
    >
      <p>{errorText(error)}</p>
      <code className="font-mono text-xs">inv:{target.invocationId}</code>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-lg border border-cafe px-3 py-2 font-semibold text-cafe-secondary"
          onClick={onRetry}
        >
          重试
        </button>
        <button
          type="button"
          className="rounded-lg border border-cafe px-3 py-2 font-semibold text-cafe-secondary"
          onClick={onBack}
        >
          返回来源
        </button>
      </div>
    </div>
  );
}

export function TrajectoryResolutionLoading({ switchingThread }: { switchingThread: boolean }) {
  return (
    <div
      className="flex h-full items-center justify-center p-4 text-sm text-cafe-muted"
      data-testid="trajectory-direct-open"
    >
      {switchingThread ? '正在切换到 canonical thread…' : '正在定位 canonical invocation…'}
    </div>
  );
}
