import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { mailboxSourcesReadable, sourceReadComplete } from './source-read-eligibility';

export type PersonalActionSource = 'mentions' | 'structuredChoices' | 'approvals' | 'needsMe' | 'all';
export type PersonalActionRefusal = 'refreshing' | 'saving' | 'identity' | 'preferences' | 'changed' | 'source';

/** Global counts need every source. A personal presentation action needs its own proven producer. */
export function personalSourceRefusal(
  read: UnifiedAttentionReadV1,
  source: PersonalActionSource,
): PersonalActionRefusal | null {
  const consistent = read.consistency.state === 'verified' && read.consistency.reasons.length === 0;
  if (source === 'all')
    return read.status === 'available' && consistent && Object.values(read.sources).every(sourceReadComplete)
      ? null
      : 'source';

  return mailboxSourcesReadable(read, source === 'mentions' ? 'userMentions' : source, 'personalPreferences')
    ? null
    : 'source';
}
