import { CodexActiveWriterRecoveryError } from '../../cats/services/runtime-session/CodexSessionReplacementProvenance.js';
import type { LiveCompanionCallOptions } from './live-call-options.js';
import type { LiveNativeActivity } from './live-native-activity.js';

export function liveFailureCode(error: Error): 'native_session_conflict' | undefined {
  return error instanceof CodexActiveWriterRecoveryError ? 'native_session_conflict' : undefined;
}

export type LiveCallState = 'preparing' | 'ready' | 'connecting' | 'talking' | 'closed' | 'failed';

export function liveCallStatus(
  options: LiveCompanionCallOptions,
  state: LiveCallState,
  toolsReady: boolean,
  nativeActivity: LiveNativeActivity['state'],
  screenAvailable: boolean,
) {
  const { binding, companion } = options;
  return {
    callId: binding.callId,
    threadId: binding.threadId,
    catId: binding.catId,
    state,
    toolsReady,
    nativeActivity,
    screenAvailable,
    ...(companion ? { companion } : {}),
  };
}
