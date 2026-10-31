/**
 * F252 Story Player — Public API
 */
export { adaptTranscriptEvents } from './adapter';
export { type CrossFeatureInfo, detectCrossFeatureEvent } from './cross-feature-detector';
export {
  computeLogCompressedDelay,
  createReplayEngine,
  pause,
  play,
  seek,
  setDisplayMode,
  setSpeed,
  stepBackward,
  stepForward,
  tick,
} from './replay-engine';
export type {
  GuestCardState,
  PlaybackState,
  RawTranscriptEvent,
  ReplayEngineState,
  ReplayEvent,
  ReplayEventType,
  SpeedMultiplier,
} from './types';
export { useReplayEngine } from './useReplayEngine';
