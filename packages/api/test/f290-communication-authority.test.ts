import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { collectiveStandingWorkSchema } from '../../shared/src/types/collective-work.js';
import { loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { formatMessage } from '../src/domains/cats/services/context/ContextAssembler.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { resolveCollectiveStandingGrant } from '../src/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { CollectiveWorkAuthority } from '../src/domains/plugin/builtin-runtime/collective-work-authority.js';

const configs = toAllCatConfigs(loadCatConfig(fileURLToPath(new URL('../../../cat-template.json', import.meta.url))));
for (const [id, config] of Object.entries(configs)) if (!catRegistry.has(id)) catRegistry.register(id, config);

test('standing scopes support address-free data while preserving readable legacy grants', () => {
  const scope = { requestingHumanIds: ['human_guest00000'], channelIds: ['general'], expiresAt: null };
  assert.equal(collectiveStandingWorkSchema.safeParse(scope).success, true);
  assert.equal(collectiveStandingWorkSchema.safeParse({ ...scope, threadId: 'legacy-address' }).success, true);
});

function source(messages: MessageStore, eventId: string, workRequest?: string) {
  return messages.append({
    userId: 'owner',
    threadId: 'channel',
    catId: null,
    mentions: [],
    timestamp: 1,
    content: `Deliver a guide for ${eventId}`,
    source: {
      connector: 'collective',
      label: 'Collective',
      meta: {
        ...(workRequest ? { workRequest } : {}),
        participation: {
          serviceInstanceId: 'svc_100000000000',
          collectiveId: 'col_100000000000',
          connectionId: 'con_100000000000',
          eventId,
          catId: 'codex',
          participationRevision: 1,
          location: { channelId: 'general' },
          actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
        },
      },
    },
  });
}

test('standing authorization is available to natural recognition and contains no execution address', async () => {
  const messages = new MessageStore();
  const request = source(messages, 'evt_100000000000');
  const connector = {
    async readParticipationContext() {
      return {};
    },
    async getProjection() {
      return { authorizedHumanId: 'human_owner00000' };
    },
    async getHostRoute() {
      return {
        localOwnerUserId: 'owner',
        revision: 1,
        agentRoutes: {
          'human_owner00000:codex': {
            standingWork: {
              threadId: 'legacy-fixed-address',
              requestingHumanIds: ['human_guest00000'],
              channelIds: ['general'],
              expiresAt: null,
            },
          },
        },
      };
    },
  };
  const current = await resolveCollectiveStandingGrant(connector, request, 'codex');
  assert.ok(current, 'natural requests can be checked against owner scope without a Composer entrust flag');
  assert.equal('threadId' in current, false, 'authorization must not choose a Task address');
});

test('same Cat A/B admissions use exact source locations; replay and revocation retain one Task each', async () => {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const requestA = source(messages, 'evt_100000000000', 'entrust');
  const requestB = source(messages, 'evt_200000000000', 'entrust');
  let revoked = false;
  const authority = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    resolveWorkThread: async (request) => `work-for-${request.id}`,
    standingGrant: async (request) =>
      revoked
        ? undefined
        : {
            threadId: 'legacy-fixed-address',
            grant: {
              grantRef: 'collective-host:scope',
              revision: 1,
              producerRef: 'host:collective-standing-work',
              grantOwnerRef: 'user:owner',
              grantOwnerRevision: 1,
              allowedSourceScope: [`message:${request.id}`],
              admissionAuthority: 'task_admit_or_resume',
              validity: { state: 'current', expiresAt: null },
              idempotencySource: 'source_ref_and_revision',
            },
          },
  });
  const a = await authority.admitStanding(requestA, 'codex');
  const b = await authority.admitStanding(requestB, 'codex');
  assert.ok(a && a.result !== 'needs_clarification');
  assert.ok(b && b.result !== 'needs_clarification');
  const taskA = await tasks.get(a.subjectRef.slice('task:work:'.length));
  const taskB = await tasks.get(b.subjectRef.slice('task:work:'.length));
  assert.equal(taskA?.threadId, `work-for-${requestA.id}`);
  assert.equal(taskB?.threadId, `work-for-${requestB.id}`);
  assert.notEqual(taskA?.threadId, taskB?.threadId);
  const replay = await authority.admitStanding(requestA, 'codex');
  assert.equal(replay?.subjectRef, a.subjectRef);
  assert.equal((await tasks.listByKind('work')).length, 2);
  revoked = true;
  assert.equal(await authority.admitStanding(requestA, 'codex'), undefined);
  assert.equal((await tasks.listByKind('work')).length, 2);
});

test('ordinary chat is not admitted just because an owner scope can be resolved', async () => {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const request = source(messages, 'evt_300000000000');
  let resolutions = 0;
  const authority = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    standingGrant: async () => {
      resolutions++;
      return undefined;
    },
  });
  assert.equal(await authority.admitStanding(request, 'codex'), undefined);
  assert.equal(resolutions, 0);
  assert.equal((await tasks.listByKind('work')).length, 0);
});

test('legacy receipt persisted before Task birth recovers one Task without rewriting receipt history or Humanizing its text', async () => {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const request = source(messages, 'evt_400000000000', 'entrust');
  const append = messages.appendIdempotent.bind(messages);
  messages.appendIdempotent = (input) =>
    append(input.extra?.collectiveOwnerAdmissionV1 ? { ...input, content: request.content } : input);
  const admit = tasks.admitEntrustedWork.bind(tasks);
  let interrupted = true;
  tasks.admitEntrustedWork = (input) => {
    if (interrupted) throw new Error('fixture crash before Task birth');
    return admit(input);
  };
  const authority = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    resolveWorkThread: async () => 'legacy-private-work',
    standingGrant: async () => ({
      grant: {
        grantRef: 'collective-host:scope',
        revision: 1,
        producerRef: 'host:collective-standing-work',
        grantOwnerRef: 'user:owner',
        grantOwnerRevision: 1,
        allowedSourceScope: [`message:${request.id}`],
        admissionAuthority: 'task_admit_or_resume' as const,
        validity: { state: 'current' as const, expiresAt: null },
        idempotencySource: 'source_ref_and_revision' as const,
      },
    }),
  });
  await assert.rejects(authority.admitStanding(request, 'codex'), /fixture crash/);
  assert.equal(tasks.listByKind('work').length, 0);
  const receipt = messages.getByThread('legacy-private-work').find((m) => m.extra?.collectiveOwnerAdmissionV1);
  assert.ok(receipt);
  const original = structuredClone(receipt);
  messages.appendIdempotent = append;
  interrupted = false;
  const recovered = await authority.admitStanding(request, 'codex');
  assert.ok(recovered && recovered.result !== 'needs_clarification');
  assert.equal(tasks.listByKind('work').length, 1);
  assert.deepEqual(messages.getById(receipt.id), original);
  assert.equal((await authority.admitStanding(request, 'codex'))?.subjectRef, recovered.subjectRef);
  assert.equal(
    messages.getByThread('legacy-private-work').filter((m) => m.extra?.collectiveOwnerAdmissionV1).length,
    1,
  );
  const context = formatMessage(receipt);
  assert.match(context, /Host 工作准入回执/);
  assert.doesNotMatch(context, /co-creator/);
  assert.match(context, /<collective_untrusted_receipt>/);
});
