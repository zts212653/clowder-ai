import type { CodexSpeedCompatibility, CodexSpeedSource, CodexSpeedValue } from '../codex-speed.js';
import type { CatId } from './ids.js';

export interface ThreadMemberSpeedRow {
  catId: CatId;
  displayName: string;
  options: readonly CodexSpeedValue[];
  override: CodexSpeedValue | null;
  inherited: CodexSpeedValue | null;
  requested: CodexSpeedValue | null;
  source: CodexSpeedSource;
  compatibility: CodexSpeedCompatibility;
  isParticipant: boolean;
}

export interface ThreadMemberSpeedListResponse {
  threadId: string;
  members: ThreadMemberSpeedRow[];
}

export interface ThreadMemberSpeedPatch {
  speed: CodexSpeedValue | null;
}
