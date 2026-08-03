import type {
  CliEffortOverrideCompatibility,
  CliEffortOverrideSource,
  CliEffortPreset,
  CliEffortValue,
} from '../cli-effort.js';
import type { CatId } from './ids.js';

export interface ThreadMemberEffortRow {
  catId: CatId;
  displayName: string;
  options: readonly CliEffortPreset[];
  override: CliEffortPreset | null;
  inherited: CliEffortValue;
  effective: CliEffortValue;
  source: CliEffortOverrideSource;
  compatibility: CliEffortOverrideCompatibility;
  isParticipant: boolean;
}

export interface ThreadMemberEffortListResponse {
  threadId: string;
  members: ThreadMemberEffortRow[];
}

export interface ThreadMemberEffortPatch {
  effort: CliEffortPreset | null;
}
