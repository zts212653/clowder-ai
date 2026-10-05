import '../../../api/test/helpers/setup-cat-registry.js';
import { readFile } from 'node:fs/promises';
import { MessageStore } from '../../../api/dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js';
import { EvolutionProgramPreparationService } from '../../../api/dist/infrastructure/capability-evolution/program-preparation-service.js';
import { Server } from '../../../api/node_modules/socket.io/dist/index.js';
import { EvolutionProgramService, MemoryEventLog } from '../../../api/test/capability-evolution-evaluation.helper.mjs';
import { objectFirstDuckBody, objectFirstMemoryBody, objectRelevance } from './f311-object-first-bodies.mjs';
import { createObjectFirstPreviewHandler } from './f311-object-first-preview.routes.mjs';
import { CONTRACT_THREAD_ID, startEvolutionWorkspaceBrowserFixture } from './f311-workspace-browser.harness.mjs';

const fixtureData = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

/** Isolated memory-only submission replay. Frozen source messages are read-only owner snapshots. */
export async function createObjectFirstPreviews(bodies) {
  const snapshot = await fixtureData('f311-preparation-seq17-snapshot');
  const sourceSnapshot = await fixtureData('f311-object-first-source-snapshots');
  const messages = [...sourceSnapshot.messages, objectRelevance.message];
  const memoryMessages = new MessageStore();
  const memoryThreads = new ThreadStore();
  const sourceThreads = [...new Set(messages.map((message) => message.threadId))].map((id) => ({
    id,
    createdBy: 'default-user',
    projectPath: '/project/cat-cafe',
    title: '原文快照 · 隔离只读回放',
  }));
  const messageStore = new Proxy(memoryMessages, {
    get(target, key) {
      if (key === 'getById') return async (id) => messages.find((message) => message.id === id) ?? target.getById(id);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const threadStore = new Proxy(memoryThreads, {
    get(target, key) {
      if (key === 'get') return async (id) => sourceThreads.find((thread) => thread.id === id) ?? target.get(id);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const thread = await threadStore.create('default-user', '对象优先 · 隔离修订预览', '/project/cat-cafe');
  const input = messageStore.append({
    userId: 'default-user',
    threadId: thread.id,
    catId: 'codex-astra',
    content: '隔离修订预览：真实代码组件，草稿内容与冻结来源快照；不是生产提交、验收或运行授权。',
    mentions: [],
    timestamp: 1789636862302,
  });
  const principal = {
    kind: 'invocation',
    invocationId: 'inv-f311-object-first-preview',
    userId: 'default-user',
    catId: 'codex-astra',
    threadId: thread.id,
  };
  const eventLog = new MemoryEventLog();
  const programs = new EvolutionProgramService({ eventLog });
  const service = new EvolutionProgramPreparationService({
    eventLog,
    projectProgram: (events) => programs.project(events),
    dependencies: {
      messageStore,
      threadStore,
      invocationReader: {
        peekRecord: async () => ({ ...principal, state: 'active', originTriggerMessageId: input.id }),
      },
    },
  });
  const make = async (key, displayName, body, previous) => {
    const created = await programs.create({
      workspaceId: 'user:default-user',
      targetRef: { ownerFeatureId: 'F311', ownerStateRef: `capability:object-first-preview-${key}` },
      displayName,
      clientMessageId: `object-first-preview-${key}`,
      actorRef: 'cat:codex-astra',
      originRef: `thread:${thread.id}:invocation:${principal.invocationId}:message:${input.id}`,
    });
    const programId = created.projection.program.programId;
    let projection = created.projection;
    const submit = async (nextBody, dependsOn = []) => {
      const section = nextBody.kind;
      const label = {
        object_map: '对象修订草稿',
        success_contract: 'seq17 好坏规约 · 冻结回放',
        measurement_plan: 'seq17 测量准备 · 冻结回放',
        baseline_diagnosis: 'seq17 初步诊断 · 冻结回放',
      }[section];
      const result = await service.submitPreparation({
        programId,
        principal,
        section,
        title: bodies
          ? nextBody === previous
            ? '原作者已发布正文 · 冻结回放'
            : `${displayName} · 阅读草稿`
          : nextBody === previous
            ? 'seq17 七项旧稿 · 隔离历史回放'
            : `${displayName} · ${label}`,
        expectedSequence: projection.program.sequence,
        clientMessageId: `${key}-${section}-${projection.program.sequence}`,
        expectedCurrentSubmissionRef: projection.preparation?.sections[section].current?.ref ?? null,
        dependsOn,
        body: nextBody,
      });
      projection = result.projection;
      return projection.preparation.sections[section].current.ref;
    };
    if (previous) await submit(previous);
    const objectRef = await submit(body);
    if (key === 'duck') {
      const successRef = await submit(bodies?.sections.success_contract ?? snapshot.sections.success_contract.body, [
        objectRef,
      ]);
      const measurementRef = await submit(
        bodies?.sections.measurement_plan ?? snapshot.sections.measurement_plan.body,
        [objectRef, successRef],
      );
      await submit(bodies?.sections.baseline_diagnosis ?? snapshot.sections.baseline_diagnosis.body, [
        objectRef,
        successRef,
        measurementRef,
      ]);
    }
    return service.get(programId);
  };
  const duck = await make(
    'duck',
    bodies?.duckName ?? '鸭鸭 · 对象优先修订预览',
    bodies?.duck ?? (await objectFirstDuckBody()),
    bodies?.previous ?? snapshot.sections.object_map.body,
  );
  const memory = await make('memory', '记忆检索 · 迁移阅读反例', bodies?.memory ?? objectFirstMemoryBody());
  return {
    duck,
    memory,
    messages,
    threads: [...sourceThreads, thread],
    snapshot,
    productionSequenceObserved: bodies?.productionSequenceObserved ?? snapshot.sequence,
  };
}

export async function startObjectFirstPreview({ bodies, ...options } = {}) {
  const data = await createObjectFirstPreviews(bodies);
  const writes = [];
  const timings = [];
  const thread = {
    id: CONTRACT_THREAD_ID,
    createdBy: 'default-user',
    title: 'F311 对象优先 · 隔离预览',
    projectPath: '/project/cat-cafe',
  };
  const threads = [thread, ...data.threads];
  const fixture = await startEvolutionWorkspaceBrowserFixture(data.duck, {
    ...options,
    configureApi(api) {
      const socket = new Server(api);
      // Read-only fixture: transport connects; no invocation or mutation handlers are installed.
      return () => new Promise((resolve) => socket.close(resolve));
    },
    handleRequest: createObjectFirstPreviewHandler({ data, threads, writes, timings }),
  });
  return { ...fixture, ...data, writes, timings };
}
