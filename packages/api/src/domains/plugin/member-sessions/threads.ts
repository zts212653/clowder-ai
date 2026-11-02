import { isAbsolute } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import {
  type OwnedThreadSeed,
  ownedThreadFromSeed,
  requireOwnedThread,
} from '../../cats/services/stores/ports/OwnedThreadSeed.js';
import { ownerRequest } from './owner-authority.js';
import { sessionIdFor } from './store.js';
import type {
  CreateMemberSession,
  EnsureMemberThread,
  MemberSessionScope,
  MemberSessionServices,
  MemberSessionSummary,
  MemberThreadBinding,
  OwnerMemberRequest,
  PluginMemberSessions,
} from './types.js';
import { coordinate, digest, prepareInput } from './validation.js';

const NAMESPACE = 'routing-threads';

/** Protection is discoverable by thread even before a grant exists. It never
 * grants execution; routing must refuse ordinary home dispatch for this thread. */
export async function readMemberThreadBinding(
  storage: MemberSessionServices['storage'],
  threadId: string,
): Promise<MemberThreadBinding | null> {
  coordinate(threadId, 512);
  const stored = await storage.get(NAMESPACE, threadId);
  if (!stored) return null;
  const row = stored.value as MemberThreadBinding | null;
  if (
    !row ||
    row.schema !== 'host.member-thread.v1' ||
    row.threadId !== threadId ||
    row.sessionId !== sessionIdFor(row.ownerUserId, threadId)
  )
    throw new Error('invalid_member_thread_binding');
  for (const key of ['ownerUserId', 'pluginInstanceId', 'catId', 'creationDigest'] as const) coordinate(row[key]);
  return structuredClone(row);
}

function creationInput(value: CreateMemberSession) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 200
  )
    throw new Error('invalid_member_thread_title');
  const { title, ...rest } = value;
  if (Object.hasOwn(rest, 'threadId')) throw new Error('member_thread_id_is_host_owned');
  const input = prepareInput({ ...rest, threadId: 'internal-member-validation' });
  return { title, input };
}

type ThreadDeps = {
  readonly scope: MemberSessionScope;
  readonly storage: MemberSessionServices['storage'];
  readonly threads: MemberSessionServices['threadCreation'];
};

async function protectedThread(
  deps: ThreadDeps,
  owner: OwnerMemberRequest,
  seed: OwnedThreadSeed,
  creationDigest: string,
): Promise<MemberThreadBinding> {
  const { scope, storage } = deps;
  if (!deps.threads) throw new Error('member_thread_creation_unavailable');
  await owner.assertCurrent();
  await scope.assertCurrent();
  const [catId] = seed.participants ?? [];
  if (!catId || seed.participants?.length !== 1) throw new Error('member_thread_requires_one_member');
  const candidate = ownedThreadFromSeed(seed);
  const binding: MemberThreadBinding = {
    schema: 'host.member-thread.v1',
    threadId: candidate.id,
    sessionId: sessionIdFor(scope.ownerUserId, candidate.id),
    ownerUserId: scope.ownerUserId,
    pluginInstanceId: scope.pluginInstanceId,
    catId,
    creationDigest,
  };
  const existing = await readMemberThreadBinding(storage, candidate.id);
  if (existing && digest(existing) !== digest(binding)) throw new Error('member_thread_creation_conflict');
  if (!existing && !(await storage.compareAndSet(NAMESPACE, candidate.id, null, binding)).applied) {
    const winner = await readMemberThreadBinding(storage, candidate.id);
    if (digest(winner) !== digest(binding)) throw new Error('member_thread_creation_conflict');
  }
  await owner.assertCurrent();
  await scope.assertCurrent();
  const thread = requireOwnedThread(await deps.threads.store.ensureOwnedThread(seed), scope.ownerUserId);
  if (thread.id !== candidate.id) throw new Error('member_thread_creation_mismatch');
  await owner.assertCurrent();
  await scope.assertCurrent();
  return binding;
}

/** Resource selection/prepare can be retried later without orphaning its protected thread. */
export function ensureOwnerMemberThread(
  deps: ThreadDeps & {
    readonly assertInstallation: MemberSessionServices['assertInstallation'];
  },
): (value: EnsureMemberThread) => Promise<MemberThreadBinding> {
  return async (value) => {
    const owner = ownerRequest(deps.scope);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['catId', 'contributionId', 'identity', 'title', 'creationKey'].includes(key))
    )
      throw new Error('invalid_member_thread_input');
    coordinate(value.creationKey);
    const { creationKey, ...rest } = value;
    const { title, input } = creationInput({ ...rest, memory: [] });
    await owner.assertCurrent();
    await deps.scope.assertCurrent();
    await deps.assertInstallation(deps.scope, input.contributionId);
    if (!deps.threads) throw new Error('member_thread_creation_unavailable');
    const projectPath = await deps.threads.workspace(deps.scope, input.catId);
    if (!isAbsolute(projectPath)) throw new Error('member_thread_workspace_unavailable');
    const seed: OwnedThreadSeed = {
      userId: deps.scope.ownerUserId,
      idempotencyKey: `member-thread:v2:${digest([deps.scope.pluginInstanceId, input.catId, creationKey])}`,
      title: title.trim(),
      participants: [createCatId(input.catId)],
      projectPath,
    };
    return protectedThread(deps, owner, seed, digest({ input, title: seed.title, projectPath }));
  };
}

export function createOwnerMemberThread(deps: {
  readonly scope: MemberSessionScope;
  readonly storage: MemberSessionServices['storage'];
  readonly threads: MemberSessionServices['threadCreation'];
  readonly prepare: PluginMemberSessions['prepare'];
}): (input: CreateMemberSession) => Promise<MemberSessionSummary> {
  const { scope } = deps;
  return async (value) => {
    const owner = ownerRequest(scope);
    const { title, input } = creationInput(value);
    await owner.assertCurrent();
    await scope.assertCurrent();
    if (!deps.threads) throw new Error('member_thread_creation_unavailable');
    const projectPath = await deps.threads.workspace(scope, input.catId);
    await owner.assertCurrent();
    await scope.assertCurrent();
    if (!isAbsolute(projectPath)) throw new Error('member_thread_workspace_unavailable');
    const seed: OwnedThreadSeed = {
      userId: scope.ownerUserId,
      idempotencyKey: `member-thread:v1:${digest([scope.pluginInstanceId, owner.requestId, input.catId])}`,
      title: title.trim(),
      participants: [createCatId(input.catId)],
      projectPath,
    };
    const binding = await protectedThread(
      deps,
      owner,
      seed,
      digest({ input, title: seed.title, projectPath, packageDigest: scope.packageDigest }),
    );
    const prepared = await deps.prepare({ ...input, threadId: binding.threadId });
    await owner.assertCurrent();
    await scope.assertCurrent();
    return prepared;
  };
}
