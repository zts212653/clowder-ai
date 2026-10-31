import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry, NEEDS_ME_PRODUCER_IDS } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../../src/config/cat-config-loader.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkOwnerReadService } from '../../src/domains/growing/EntrustedWorkOwnerReadService.js';
import { NeedsMeProducerCatalog } from '../../src/domains/growing/NeedsMeProducerCatalog.js';
import { createCollectiveWorkCalendarReader } from '../../src/domains/plugin/host-surface/collective-work-calendar.js';

for (const [id, config] of Object.entries(
  toAllCatConfigs(loadCatConfig(fileURLToPath(new URL('../../../../cat-template.json', import.meta.url)))),
)) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}

test('Schedule reads the current public Work onto one original Task and never persists those dates', async () => {
  const tasks = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  const admitted = await lifecycle.admitOrResume({
    task: {
      threadId: 'private-thread',
      ownerCatId: 'codex-sol',
      title: 'Original work',
      why: 'One task',
      userId: 'owner',
      createdBy: 'user',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:original'],
      intendedOutcome: 'Deliver the work',
      idempotencyKey: 'calendar:original',
    },
    closure: { condition: 'Deliver', expectedSignal: 'result' },
    time: { businessDeadline: { value: 1_800_000_000_000, sourceRef: 'message:original' } },
  });
  assert.notEqual(admitted.result, 'needs_clarification');
  if (admitted.result === 'needs_clarification') throw new Error('Fixture admission failed');
  const original = await tasks.get(admitted.ownerRef.replace('task:item:', ''));
  assert.ok(original?.entrustedWork);
  let reads = 0,
    value = '2026-10-30T15:59:00Z',
    unavailable = false;
  const fact = () => ({
    value,
    timeZone: 'Asia/Shanghai',
    actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
    at: '2026-10-26T00:00:00Z',
    sourceRef: 'event:evt_aaaaaaaa',
  });
  const reader = createCollectiveWorkCalendarReader(
    {
      async runAction(pluginId, operation, action) {
        assert.equal(pluginId, 'official.collective-connector');
        assert.equal(operation, 'calendar');
        assert.equal(action, 'read');
        reads++;
        return {
          matched: true,
          status: 200,
          body: {
            data: {
              items: unavailable
                ? []
                : [
                    {
                      taskId: original.id,
                      taskRevision: original.entrustedWork!.revision,
                      serviceInstanceId: 'svc_aaaaaaaa',
                      collectiveId: 'col_aaaaaaaa',
                      connectionId: 'con_aaaaaaaa',
                      serviceUrl: 'http://127.0.0.1:5201',
                      location: { channelId: 'general' },
                      workId: 'work_aaaaaaaa',
                      workRevision: reads,
                      time: { businessDeadline: fact() },
                    },
                  ],
              unavailableTaskIds: unavailable ? [original.id] : [],
            },
          },
        };
      },
    },
    'owner',
  );
  const producerCatalog = new NeedsMeProducerCatalog(
    NEEDS_ME_PRODUCER_IDS.map((producerId) => ({
      producerId,
      async listCurrentReceipts() {
        return [];
      },
      async readCurrentReceipt() {
        return null;
      },
    })),
  );
  const service = new EntrustedWorkOwnerReadService({ tasks, producerCatalog, collectiveCalendarReader: reader });
  const first = await service.readForOwner('owner');
  assert.equal(first.ownerReads.length, 1);
  assert.equal(first.ownerReads[0].timeRefs[0].value, Date.parse(value));
  assert.equal(first.ownerReads[0].publicTime?.state, 'current');
  value = '2026-11-06T15:59:00Z';
  assert.equal((await service.readForOwner('owner')).ownerReads[0].timeRefs[0].value, Date.parse(value));
  assert.deepEqual(await tasks.get(original.id), original);
  unavailable = true;
  const revoked = (await service.readForOwner('owner')).ownerReads[0];
  assert.deepEqual(revoked.timeRefs, []);
  assert.equal(revoked.publicTime?.state, 'unavailable');
  assert.deepEqual(await service.listForOwner('another-owner'), []);
  assert.deepEqual(await tasks.get(original.id), original);
});
