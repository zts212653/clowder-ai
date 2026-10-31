import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import {
  PROGRAM_ADAPTER_MEDIA_CONTENT_TYPES,
  PROGRAM_ADAPTER_MEDIA_MAX_BYTES,
  type ProgramAdapterMediaContentType,
} from './program-adapter-media-contract.js';

export type MicroduckShowMediaSource = 'real_capture' | 'faithful_replay';
export type MicroduckShowMediaKind = 'image' | 'video';
export type MicroduckShowMediaContentType = ProgramAdapterMediaContentType;
export const MICRODUCK_SHOW_MEDIA_CONTENT_TYPES = PROGRAM_ADAPTER_MEDIA_CONTENT_TYPES;
export const MICRODUCK_SHOW_MEDIA_MAX_BYTES = PROGRAM_ADAPTER_MEDIA_MAX_BYTES;

export interface MicroduckShowMediaDescriptor {
  sceneIndex: number;
  source: MicroduckShowMediaSource;
  captureRef: OwnerTruthRefV1;
  kind: MicroduckShowMediaKind;
}

export interface MicroduckShowMediaAsset {
  status: 'resolved';
  captureRef: OwnerTruthRefV1;
  kind: MicroduckShowMediaKind;
  contentType: MicroduckShowMediaContentType;
  bytes: Uint8Array;
}
