import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  type CollectiveAccountabilitySource,
  readCollectiveAccountabilityAttentionSource,
} from '../../../../../../api/src/routes/companion-collective-accountability-source';
import { parseUnifiedAttentionRead } from '../../parse-unified-attention';
import { personalSourceRefusal } from '../personal-action-eligibility';
import boot58Sources from './mailbox-boot58-source-state.json';
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
  it('isolates the boot58 Host double-path failure from healthy mentions, choices and approvals', () => {
    const base = okRead([]);
    if (base.kind !== 'ok') throw new Error('Expected a usable base read');
    // Real native GET projection at b101e463, Studio human source 0001793154853276-000101-aeb7fba8.
    const read = parseUnifiedAttentionRead({ ...base.read, ...boot58Sources, totalCount: undefined });
    if (!read) throw new Error('The captured Host source combination must remain structurally valid');
    expect(read.sources.needsMe.exhaustiveness).toBe('partial');
    for (const source of ['mentions', 'structuredChoices', 'approvals'] as const)
      expect(personalSourceRefusal(read, source)).toBeNull();
    expect(personalSourceRefusal(read, 'needsMe')).toBe('source');
    expect(personalSourceRefusal(read, 'all')).toBe('source');
    expect(read.status).toBe('partial');
    expect(read.totalCount).toBeUndefined();
  });

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
    'unauthenticated',
    'forbidden',
    'invalid',
  ] as const)('an unrelated %s source still refuses personal actions because its identity/shape is unverified', async (status) => {
    const read = await readWithHostFailure(undefined);
    read.sources.needsMe = { ...read.sources.needsMe, status, exhaustiveness: 'unknown' };
    expect(personalSourceRefusal(read, 'mentions')).toBe('source');
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe('source');
  });

  it.each([
    'approvals',
    'needsMe',
    'userMentions',
    'structuredChoices',
  ] as const)('a partial %s does not become a required dependency of every other personal action', async (source) => {
    const read = await readWithHostFailure(undefined);
    const collective = read.sources.collectiveAccountabilityRequests;
    const value = read.sources[source];
    if (!collective || !value) throw new Error('Required source fixture missing');
    read.sources.collectiveAccountabilityRequests = { ...collective, status: 'available', exhaustiveness: 'complete' };
    read.sources[source] = { ...value, exhaustiveness: 'partial' };
    read.consistency = { state: 'verified', reasons: [] };
    for (const operation of ['mentions', 'approvals', 'structuredChoices', 'needsMe'] as const)
      expect(personalSourceRefusal(read, operation)).toBe(
        (operation === 'mentions' ? 'userMentions' : operation) === source ? 'source' : null,
      );
    expect(personalSourceRefusal(read, 'all')).toBe('source');
  });

  it.each([
    'userMentions',
    'structuredChoices',
    'approvals',
    'needsMe',
    'personalPreferences',
  ] as const)('only the actions that need %s are refused when its evidence is unavailable', async (source) => {
    const read = await readWithHostFailure(undefined);
    const value = read.sources[source];
    if (!value) throw new Error('Required source fixture missing');
    read.sources[source] = { ...value, status: 'unavailable', exhaustiveness: 'unknown' };
    expect(personalSourceRefusal(read, 'mentions')).toBe(
      source === 'userMentions' || source === 'personalPreferences' ? 'source' : null,
    );
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe(
      source === 'structuredChoices' || source === 'personalPreferences' ? 'source' : null,
    );
    expect(personalSourceRefusal(read, 'all')).toBe('source');
  });

  it('requires an explicit complete producer even when its optional source is absent', async () => {
    const read = await readWithHostFailure(undefined);
    delete read.sources.structuredChoices;
    expect(personalSourceRefusal(read, 'structuredChoices')).toBe('source');
  });
});
