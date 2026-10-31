import type { LiveSharedScreen } from '../live-shared-screen.js';

export type LiveScreenAction =
  | { kind: 'open'; selectionId: string; label: string }
  | { kind: 'frame'; selectionId: string; frame: Parameters<LiveSharedScreen['frame']>[1] }
  | { kind: 'close' };

export function shareLiveScreen(
  screen: LiveSharedScreen | undefined,
  action: LiveScreenAction,
  available: boolean,
): void {
  if (action.kind === 'close') {
    screen?.stop();
    return;
  }
  if (!available || !screen) throw new Error('Live screen unavailable');
  if (action.kind === 'open') screen.open(action.selectionId, action.label);
  else screen.frame(action.selectionId, action.frame);
}
