import assert from 'node:assert/strict';
import '../../../api/test/helpers/setup-cat-registry.js';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js';
import { EvolutionProgramPreparationService } from '../../../api/dist/infrastructure/capability-evolution/program-preparation-service.js';
import { EvolutionProgramService, MemoryEventLog } from '../../../api/test/capability-evolution-evaluation.helper.mjs';

/** Browser inputs travel through production parsing, F117 materialization and Program projection. */
export async function createSubmittedChoiceProjection(preparationFixture, authoredBody) {
  const eventLog = new MemoryEventLog();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('default-user', '陌生项目的准备选择', '/project/cat-cafe');
  const input = messageStore.append({
    userId: 'default-user',
    threadId: thread.id,
    catId: null,
    content: 'Europa 晨会材料路由：本轮保持固定，先核清失败分母。',
    mentions: [],
    timestamp: Date.parse('2026-09-14T08:00:00.000Z'),
  });
  const principal = {
    kind: 'invocation',
    invocationId: 'inv-choice-browser',
    userId: 'default-user',
    catId: 'codex-astra',
    threadId: thread.id,
  };
  const programService = new EvolutionProgramService({ eventLog });
  const created = await programService.create({
    workspaceId: 'user:default-user',
    targetRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:europa-routing' },
    displayName: authoredBody ? '鸭鸭准备 · 原作者内容隔离回放' : 'Europa 晨会材料路由',
    clientMessageId: input.id,
    actorRef: 'cat:codex-astra',
    originRef: `thread:${thread.id}:invocation:${principal.invocationId}:message:${input.id}`,
  });
  const options = {
    eventLog,
    projectProgram: (events) => programService.project(events),
    dependencies: {
      messageStore,
      threadStore,
      invocationReader: {
        peekRecord: async () => ({ ...principal, state: 'active', originTriggerMessageId: input.id }),
      },
    },
  };
  const service = new EvolutionProgramPreparationService(options);
  const body = structuredClone(authoredBody ?? preparationFixture().sections.object_map.current.submission.body);
  if (!authoredBody) {
    const item = body.items[0];
    const ref = { ownerFeatureId: 'F117', ownerStateRef: `message:${input.id}` };
    body.goalStatement = input.content;
    item.category = 'Harness / 信息转交';
    item.label = 'Europa 晨会材料路由';
    item.recommendation = { summary: '先核失败分母', reason: '区分漏交接与材料缺失', basisRefs: [ref] };
    item.existingWork = { summary: '已有三条可回读失败记录，尚未独立核验', sourceRefs: [ref] };
    item.decision = {
      state: 'fixed',
      reason: '转录人的本轮选择',
      basisRefs: [ref],
      responsibility: { kind: 'human', input: { threadId: thread.id, messageId: input.id } },
    };
  }
  const submitted = await service.submitPreparation({
    programId: created.projection.program.programId,
    expectedSequence: 1,
    clientMessageId: 'submit-stranger',
    principal,
    section: 'object_map',
    title: '陌生项目的真实提交链',
    expectedCurrentSubmissionRef: null,
    dependsOn: [],
    body,
  });
  const projection = await new EvolutionProgramPreparationService(options).get(created.projection.program.programId);
  const current = projection.preparation.sections.object_map.current;
  if (!authoredBody) assert.equal(current.inputSources[0].messageId, input.id);
  assert.equal(current.sourceMessageId, input.id);
  assert.deepEqual(projection.preparation, submitted.projection.preparation);
  assert.equal(current.submission.authorCatId, 'codex-astra');
  return { projection, inputId: input.id, revision: current.ref.version };
}
