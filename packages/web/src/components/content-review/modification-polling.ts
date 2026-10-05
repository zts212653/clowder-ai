import type { ContentModificationRequestView } from '@cat-cafe/shared';

const MOVING_EXECUTION = new Set(['queued', 'starting', 'running', 'withdrawn_running', 'unknown']);
/**
 * A request is settled when nothing the owner reads can still change: the human
 * cancelled it and its Task is closed (or it was retired), and no execution is
 * still moving. Live requests are never settled here.
 *
 * Only `closed` counts: `preserved` / `owner_changed` leave the shared Task open,
 * and text respond checks the Task rather than this request's control, so a later
 * same-Task turn can still persist a candidate on this requestId.
 */
export function isSettledModification(view: ContentModificationRequestView): boolean {
  if (view.execution && MOVING_EXECUTION.has(view.execution.state)) return false;
  if (view.stage === 'retired') return true;
  const control = view.record.control;
  return view.stage === 'cancelled' && control?.taskResolution === 'closed';
}
