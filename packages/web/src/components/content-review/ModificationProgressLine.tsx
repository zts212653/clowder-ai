import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { ModificationProgressRow } from './ModificationProgressRow';
import { isMovingModification } from './modification-polling';
import { useModificationProgress } from './useModificationProgress';

/**
 * Live progress of one request, read from its owner and cancellable in place. Every message that started a
 * request shows it through this one line, so a text request and an image request describe the same state in the
 * same words and take the same actions.
 */
export function ModificationProgressLine(props: {
  requestId: string;
  targetName: string;
  contentTitle?: string;
  /** How many places on the work the request covers; absent or zero is never printed. */
  placeCount?: number;
  /** Work headers show ongoing requests; Chat retains each request's terminal outcome. */
  ongoingOnly?: boolean;
}) {
  const progress = useModificationProgress(props);
  if (!progress.copy) return null;
  if (props.ongoingOnly && progress.readState === 'ok' && progress.view && !isMovingModification(progress.view))
    return null;
  const { executionThreadId } = progress;
  return (
    <ModificationProgressRow
      copy={progress.copy}
      busy={progress.busy}
      notice={progress.cancelError}
      handlers={{
        'cancel-request': () => void progress.cancel(),
        reload: () => void progress.reload(),
        'open-execution': executionThreadId ? () => pushThreadRouteWithHistory(executionThreadId, window) : undefined,
      }}
    />
  );
}
