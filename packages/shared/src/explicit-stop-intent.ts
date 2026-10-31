export const EXPLICIT_STOP_SOURCE_CONTROLS = ['chat_input_banner', 'chat_input_action', 'parallel_status_bar'] as const;

export const EXPLICIT_STOP_GESTURES = ['pointer', 'keyboard'] as const;

export type ExplicitStopSourceControl = (typeof EXPLICIT_STOP_SOURCE_CONTROLS)[number];
export type ExplicitStopGesture = (typeof EXPLICIT_STOP_GESTURES)[number];

export interface ExplicitStopIntent {
  sourceControl: ExplicitStopSourceControl;
  gesture: ExplicitStopGesture;
  trustedGesture: boolean;
}

export function isExplicitStopSourceControl(value: unknown): value is ExplicitStopSourceControl {
  return typeof value === 'string' && (EXPLICIT_STOP_SOURCE_CONTROLS as readonly string[]).includes(value);
}

export function isExplicitStopGesture(value: unknown): value is ExplicitStopGesture {
  return typeof value === 'string' && (EXPLICIT_STOP_GESTURES as readonly string[]).includes(value);
}
