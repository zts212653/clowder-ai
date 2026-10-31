export type ListenRetention = '7d' | '30d' | 'forever';
export type ListenPlaybackRate = 0.75 | 1 | 1.25 | 1.5 | 2;

export interface ListenDocumentIdentity {
  projectPath: string;
  relativePath: string;
  contentDigest: string;
}

export interface ListenSentenceState {
  anchor: string;
  assetId?: string;
}

export interface ListenDocumentState {
  identity: ListenDocumentIdentity;
  sentences: ListenSentenceState[];
  /** Server-derived voice/model/processing identity for the currently valid links. */
  synthesisFingerprint?: string;
  position: { anchor: string | null; offsetSeconds: number };
  playbackRate: ListenPlaybackRate;
  retention: ListenRetention;
  updatedAt: number;
}
