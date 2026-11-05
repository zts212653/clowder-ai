import assert from 'node:assert/strict';
import test from 'node:test';
import { F290CollectiveWorkResultPluginAdapter } from '../dist/domains/growing/F290CollectiveWorkResultPluginAdapter.js';

const subjectRef = 'collective-result:con_abcdefgh:work_abcdefgh';
const receipt = {
  eligible: true,
  producer: {
    producerId: 'f290.collective_work_result',
    ownerRef: subjectRef,
    subjectRef,
    revision: 7,
  },
  taskRef: { subjectRef: 'task:work:task_abcdefgh', observedRevision: 3 },
  kind: 'judgment',
  reasonCode: 'collective_result_ready',
  recommendation: 'Review the prepared result in its Collective Work',
  salience: 'normal',
  action: {
    actionRef:
      '/collective?connectionId=con_abcdefgh&workId=work_abcdefgh&workRevision=7&channelId=general&resultEventId=evt_abcdefgh&resultRevision=1',
    expectedProducerRevision: 7,
  },
  reEvaluateActionRef: `${subjectRef}#reevaluate`,
};

const source =
  (data, options = {}) =>
  async () => ({
    matched: options.matched ?? true,
    status: options.status ?? 200,
    body: {
      data: {
        items: [receipt],
        reasons: [],
        state: {
          coverage: 'current_f290_collective_work_results',
          startedAt: 1,
          observedAt: 2,
          status: 'available',
          exhaustiveness: 'complete',
        },
        ...data,
      },
    },
  });

test('the Host catalog consumes the installed plugin receipt without rebuilding F290 business truth', async () => {
  const adapter = new F290CollectiveWorkResultPluginAdapter(source());
  assert.deepEqual(await adapter.listCurrentReceipts('owner'), [receipt]);
  assert.deepEqual(await adapter.readCurrentReceipt({ ownerUserId: 'owner', producerSubjectRef: subjectRef }), receipt);
  assert.deepEqual(
    await adapter.reEvaluate({
      ownerUserId: 'owner',
      producerSubjectRef: subjectRef,
      expectedProducerRevision: 7,
      taskRef: receipt.taskRef,
      reEvaluateActionRef: receipt.reEvaluateActionRef,
    }),
    { state: 'unchanged', producerRevision: 7 },
  );
});

test('only a genuinely absent plugin is optional; installed missing, partial, and healthy-empty sources stay distinct', async () => {
  const absent = new F290CollectiveWorkResultPluginAdapter(source({ items: [] }, { matched: false, status: 404 }));
  assert.deepEqual(await absent.listCurrentReceipts('owner'), []);
  const installedMissingAction = new F290CollectiveWorkResultPluginAdapter(
    source({ items: [] }, { matched: true, status: 404 }),
  );
  await assert.rejects(installedMissingAction.listCurrentReceipts('owner'), /unavailable/);
  const partial = new F290CollectiveWorkResultPluginAdapter(
    source({
      reasons: ['collective_result_candidate_changed'],
      state: {
        coverage: 'current_f290_collective_work_results',
        startedAt: 1,
        observedAt: 2,
        status: 'available',
        exhaustiveness: 'partial',
      },
    }),
  );
  await assert.rejects(partial.listCurrentReceipts('owner'), /incomplete/);
  const healthyEmpty = new F290CollectiveWorkResultPluginAdapter(source({ items: [] }));
  assert.deepEqual(await healthyEmpty.listCurrentReceipts('owner'), []);
});
