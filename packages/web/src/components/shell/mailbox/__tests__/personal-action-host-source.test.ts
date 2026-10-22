import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  type CollectiveAccountabilitySource,
  readCollectiveAccountabilityAttentionSource,
} from '../../../../../../api/src/routes/companion-collective-accountability-source';
import { parseUnifiedAttentionRead } from '../../parse-unified-attention';
import { personalSourceRefusal } from '../personal-action-eligibility';
import { okRead } from './mailbox-fixtures';

async function readWithHostFailure(
  reader: CollectiveAccountabilitySource | undefined,
): Promise<UnifiedAttentionReadV1> {
  const result = okRead([]);
  if (result.kind !== 'ok') throw new Error('Expected a usable base read');
  const read = result.read;
  const complete = read.sources.approvals;
  read.sources.personalPreferences = { ...complete, coverage: 'owner_personal_ignored_items' };
  read.sources.userMentions = { ...complete, coverage: 'explicit_user_mentions' };
  read.sources.structuredChoices = { ...complete, coverage: 'pending_f306_structured_choices' };
  const host = await readCollectiveAccountabilityAttentionSource(reader, read.identity.ownerUserId);
  read.sources.collectiveAccountabilityRequests = host.state;
  read.consistency = { state: 'uncertain', reasons: host.reasons };
  read.status = 'partial';
  delete read.totalCount;
  expect(parseUnifiedAttentionRead(read)).not.toBeNull();
  return read;
}

describe('Personal actions consume the actual Host Collective failure projection', () => {
  it.each([
    ['missing plugin', undefined],
    [
      'plugin execution failed',
      async () => {
        throw new Error('Plugin stopped');
      },
    ],
    ['transport unavailable', async () => ({ status: 503, body: {} })],
  ] satisfies [
    string,
    CollectiveAccountabilitySource | undefined,
  ][])('%s only blocks the failed source and global actions', async (_label, reader) => {
    const read = await readWithHostFailure(reader);
    expect(read.sources.collectiveAccountabilityRequests?.status).toBe('unavailable');
    expect(personalSourceRefusal(read, 'mentions')).toBeNull();
    expect(personalSourceRefusal(read, 'structuredChoices')).toBeNull();
    expect(personalSourceRefusal(read, 'approvals')).toBeNull();
    expect(personalSourceRefusal(read, 'needsMe')).toBeNull();
    expect(personalSourceRefusal(read, 'all')).toBe('source');
  });

  it.each([401, 403, 200])('Host %s identity/invalid response stays blocked', async (status) => {
    const read = await readWithHostFailure(async () => ({ status, body: {} }));
    expect(personalSourceRefusal(read, 'mentions')).toBe('source');
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe('source');
  });

  it('preserves the legacy connection failure while refusing unknown or mixed reasons', async () => {
    const read = await readWithHostFailure(undefined);
    read.consistency.reasons = ['collective_accountability_connection_read_failed'];
    expect(personalSourceRefusal(read, 'mentions')).toBeNull();
    read.consistency.reasons.push('unrecognized_identity_conflict');
    expect(personalSourceRefusal(read, 'mentions')).toBe('source');
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe('source');
  });

  it.each([
    'userMentions',
    'structuredChoices',
    'approvals',
    'needsMe',
    'personalPreferences',
  ] as const)('still refuses when required %s evidence is unavailable', async (source) => {
    const read = await readWithHostFailure(undefined);
    const value = read.sources[source];
    if (!value) throw new Error('Required source fixture missing');
    read.sources[source] = { ...value, status: 'unavailable', exhaustiveness: 'unknown' };
    expect(personalSourceRefusal(read, 'mentions')).toBe('source');
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe('source');
  });

  it('requires an explicit complete producer even when its optional source is absent', async () => {
    const read = await readWithHostFailure(undefined);
    delete read.sources.structuredChoices;
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe('source');
  });
});
