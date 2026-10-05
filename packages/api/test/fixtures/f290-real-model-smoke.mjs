import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { builtinAccountIdForClient, resolveForClient } from '../../src/config/account-resolver.ts';
import { loadResolvedCatConfig, toAllCatConfigs } from '../../src/config/cat-config-loader.ts';
import {
  guideFeedback,
  guideRequest,
  originalChannelResult,
  provePriorArtifactRead,
  provePublishedMarkdown,
} from './f290-real-model-artifact.mjs';
import {
  captureModelObservations,
  executableFingerprint,
  safeEvidence,
  verifiedModelInvocations,
} from './f290-real-model-evidence.mjs';
import { createModelHost } from './f290-real-model-host.mjs';
import { createModelWorld } from './f290-real-model-world.mjs';

if (process.env.F290_REAL_MODEL_OPT_IN !== '1') throw new Error('Explicit F290_REAL_MODEL_OPT_IN=1 required');
const repo = resolve(process.env.F290_REAL_MODEL_REPO);
const catalogRoot = resolve(process.env.F290_REAL_MODEL_CATALOG_ROOT);
process.env.CAT_CAFE_CONFIG_ROOT = catalogRoot;
const catId = process.env.F290_REAL_MODEL_CAT_ID;
const all = toAllCatConfigs(
  loadResolvedCatConfig(join(catalogRoot, 'cat-template.json'), { persistMigrations: false }),
);
const config = all[catId];
assert.ok(config, `Configured Cat ${catId} is unavailable`);
assert.equal(config.clientId, 'openai', 'Only the supported production private Codex provider may run');
const cli = config.cli?.command ?? 'codex';
const status = spawnSync(cli, ['login', 'status'], { encoding: 'utf8' });
assert.equal(status.status, 0, 'Canonical CLI auth status must be ready');
const authStatus = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim();
const bootstrapOAuth = process.env.F290_REAL_MODEL_AUTH_BOOTSTRAP === 'cli-oauth';
if (bootstrapOAuth) {
  assert.match(authStatus, /Logged in using ChatGPT/i);
  const oauthRef = builtinAccountIdForClient('openai');
  assert.equal(resolveForClient(catalogRoot, 'openai', oauthRef)?.authType, 'oauth');
  all[catId] = { ...config, accountRef: oauthRef };
}
const account = resolveForClient(catalogRoot, 'openai', all[catId].accountRef);
const accountReadiness = {
  id: account?.id,
  authType: account?.authType,
  kind: account?.kind,
  credentialPresent: Boolean(account?.apiKey),
  baseUrlHost: account?.baseUrl ? new URL(account.baseUrl).hostname : undefined,
};
for (const [id, cat] of Object.entries(all)) if (!catRegistry.has(id)) catRegistry.register(id, cat);
const cliVersion = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim();
const root = await mkdtemp(join(tmpdir(), 'f290-real-model-'));
process.env.CAT_CAFE_DATA_DIR = join(root, 'native-data');
process.env.UPLOAD_DIR = join(root, 'uploads');
process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = '1';
// tsx is already registered. Its test-loader NODE_OPTIONS must not escape into the installed CLI's isolated cwd.
delete process.env.NODE_OPTIONS;
const startedAt = new Date().toISOString();
const evidence = {
  startedAt,
  startupSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  scope: 'two in-process production Host compositions; index.ts not started',
  modelTransport: 'production CodexAgentService, installed Codex CLI, canonical configured auth; no transport stub',
  configuredCat: {
    catId,
    displayName: config.displayName,
    requestedModel: config.defaultModel,
    cliVersion,
    catalogRoot,
    authReadiness: authStatus || 'codex login status exited 0',
    authBootstrap: bootstrapOAuth
      ? 'driver selects production builtin OAuth ref from canonical CLI status; no catalog write'
      : 'configured account resolution',
    accountReadiness,
  },
  fixtureHumans: true,
  binaryRoot: process.env.CAT_CAFE_RUNTIME_ROOT,
  executableFingerprintAtStart: await executableFingerprint(repo),
  startupTrackedWip: execFileSync('git', ['diff', '--name-only'], { cwd: repo, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean),
  dataRoot: root,
  callbacks: [],
  frames: [],
  logs: [],
  authLifecycles: [],
  agentVerifications: [],
  hosts: [],
  scenarios: [],
};
const hosts = [];
let world;
let failure;
const timeoutMs = Math.min(Number(process.env.F290_REAL_MODEL_TIMEOUT_MS ?? 900000), 900000);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000);
const deadline = Date.now() + timeoutMs;
const timer = setTimeout(() => {
  void Promise.all(hosts.map((host) => host.abort()));
}, timeoutMs);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function pump(predicate, label) {
  const framesBefore = evidence.frames.length;
  let idleTerminals = 0;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`True-model smoke deadline reached: ${label}`);
    for (const host of hosts) await host.tick();
    const errors = evidence.frames.filter((frame) => frame.type === 'error' && frame.errorDisposition !== 'transient');
    if (errors.length > 0) throw new Error(`Real provider/callback failure: ${JSON.stringify(errors.at(-1))}`);
    const terminalSeen = evidence.frames.slice(framesBefore).some((frame) => frame.type === 'done');
    const idle = (await Promise.all(hosts.map((host) => host.idle()))).every(Boolean);
    idleTerminals = terminalSeen && idle ? idleTerminals + 1 : 0;
    if (idleTerminals >= 5) throw new Error(`Real model finished without required durable outcome: ${label}`);
    await sleep(500);
  }
}

async function privateTask(host, work) {
  const matches = [];
  for (const task of await host.tasks.listByKind('work')) {
    const sourceRef = task.entrustedWork?.admission.sourceRefs[0];
    const source = sourceRef ? await host.messages.getById(sourceRef.slice('message:'.length)) : undefined;
    if (source?.source?.meta?.eventId === work.assignmentEventId) matches.push(task);
  }
  assert.equal(matches.length, 1, 'One immutable accepted assignment must admit exactly one private Task');
  return matches[0];
}

function workProof(work, task) {
  return {
    workId: work.workId,
    sourceEventId: work.sourceEventId,
    assignmentEventId: work.assignmentEventId,
    accountableHumanId: work.accountableHumanId,
    lifecycle: work.lifecycle,
    revision: work.revision,
    resultRevision: work.resultRevision,
    resultEventId: work.resultEventId,
    executionAuthority: work.executionAuthority,
    acceptance: work.acceptance,
    taskId: task.id,
    threadId: task.threadId,
    taskStatus: task.status,
    taskBirth: task.entrustedWork?.admission,
    taskExecution: task.entrustedWork?.execution,
    taskClosure: task.entrustedWork?.closure,
  };
}

async function naturalRequest(from, targetHost, tag) {
  const request = await world.post(from, targetHost.cafe, guideRequest(tag), targetHost.participationRevision);
  await pump(
    async () =>
      world.works().some((work) => work.sourceEventId === request.eventId && work.lifecycle === 'result_ready') &&
      (await targetHost.idle()),
    `${tag}: actual Cat accepts and returns result`,
  );
  const work = world.works().find((row) => row.sourceEventId === request.eventId);
  assert.ok(work?.acceptance);
  const assignment = (await world.store.listEventsForHuman(world.a.sessionToken, world.coordinates.collectiveId)).find(
    (event) => event.eventId === work.assignmentEventId,
  );
  assert.equal(assignment?.actor.kind, 'agent');
  assert.equal(assignment.actor.agent.agentId, catId);
  assert.equal(work.accountableHumanId, targetHost.cafe.humanId);
  const task = await privateTask(targetHost, work);
  assert.notEqual(task.threadId, targetHost.endpoint.id);
  assert.equal(task.entrustedWork.closure.state, 'open');
  const artifact = await provePublishedMarkdown(targetHost, work, task, evidence);
  artifact.originalChannelResult = await originalChannelResult(world, work, catId);
  evidence.scenarios.push({
    name: tag,
    artifact,
    state: 'actual Cat result_ready',
    requestEventId: request.eventId,
    proof: workProof(work, task),
  });
  return { work, task, request, artifact };
}

try {
  world = await createModelWorld(root, catId, evidence);
  const hostA = await createModelHost(world, world.a, 16, config, evidence);
  hosts.push(hostA);
  const hostB = await createModelHost(world, world.b, 17, config, evidence);
  hosts.push(hostB);
  console.log(
    JSON.stringify({
      stage: 'ready',
      catId,
      requestedModel: config.defaultModel,
      cliVersion,
      service: world.server.url,
      hosts: evidence.hosts,
      timeoutMs,
    }),
  );

  const a1 = await naturalRequest(world.b, hostA, 'A');
  console.log(JSON.stringify({ stage: 'A-result', workId: a1.work.workId, taskId: a1.task.id }));
  const feedback = await world.post(
    world.b,
    world.a,
    guideFeedback,
    hostA.participationRevision,
    a1.work.resultEventId,
  );
  await pump(
    async () =>
      world.work(a1.work.workId).lifecycle === 'result_ready' &&
      world.work(a1.work.workId).resultRevision === 2 &&
      (await hostA.idle()),
    'free-text feedback chooses actual signed continue_work and v2',
  );
  const a2 = world.work(a1.work.workId);
  const sameTask = await privateTask(hostA, a2);
  assert.equal(a2.workId, a1.work.workId);
  assert.equal(a2.assignmentEventId, a1.work.assignmentEventId);
  assert.equal(sameTask.id, a1.task.id);
  assert.equal(sameTask.threadId, a1.task.threadId);
  assert.deepEqual(sameTask.entrustedWork.admission, a1.task.entrustedWork.admission);
  const continuation = evidence.callbacks.find(
    (row) => row.path === '/api/callbacks/collective-continue-work' && row.status === 200,
  );
  assert.ok(continuation?.input?.workRef, 'The real model must choose the current signed Work ref');
  await assert.rejects(
    world.store.acceptCollectiveWorkResult(world.a.sessionToken, {
      ...world.coordinates,
      requestId: 'fixture-stale-result-rejected',
      workId: a2.workId,
      expectedRevision: a2.revision,
      resultEventId: a1.work.resultEventId,
      resultRevision: 1,
    }),
  );
  assert.equal((await hostA.tasks.get(a1.task.id)).entrustedWork.closure.state, 'open');
  const revisedArtifact = await provePublishedMarkdown(hostA, a2, sameTask, evidence);
  revisedArtifact.originalChannelResult = await originalChannelResult(world, a2, catId);
  const priorArtifactRead = provePriorArtifactRead(hostA, a1.artifact, revisedArtifact, evidence);
  await world.accept(world.a, a2);
  await hostA.reconcile(world.work(a2.workId));
  assert.equal((await hostA.tasks.get(a1.task.id)).entrustedWork.closure.state, 'satisfied');
  evidence.scenarios.push({
    name: 'A free-text continuation v2',
    state: 'fixture accountable Human accepted current result',
    feedbackEventId: feedback.eventId,
    signedWorkRef: continuation.input.workRef,
    staleV1AcceptanceRejected: true,
    artifact: revisedArtifact,
    priorArtifactRead,
    proof: workProof(world.work(a2.workId), await hostA.tasks.get(a1.task.id)),
  });

  const b1 = await naturalRequest(world.a, hostB, 'B reverse path');
  await world.accept(world.b, b1.work);
  await hostB.reconcile(world.work(b1.work.workId));
  assert.equal((await hostB.tasks.get(b1.task.id)).entrustedWork.closure.state, 'satisfied');
  evidence.scenarios.push({
    name: 'B reverse path acceptance',
    state: 'fixture accountable Human accepted',
    proof: workProof(world.work(b1.work.workId), await hostB.tasks.get(b1.task.id)),
  });

  const before = structuredClone(world.works());
  const decisionsBefore = evidence.callbacks.filter((row) =>
    /collective-(?:accept|continue)-work$/.test(row.path),
  ).length;
  for (const body of [
    '你好，今天过得怎么样？只是闲聊，不需要帮我做事。',
    '事项 A 的进度现在怎样？只问当前状态，不请求继续或修改。',
  ]) {
    const request = await world.post(world.b, world.a, body, hostA.participationRevision);
    await pump(async () => {
      const inbox = await world.a.connector.listInbox(world.a.connectionId);
      const item = inbox.find((row) => row.event.eventId === request.eventId);
      return item?.disposition === 'routed' && (await hostA.idle());
    }, 'ordinary chat/progress question completes without Work');
    assert.deepEqual(world.works(), before, 'Chat/status must not create or revise accepted Work');
    assert.equal(
      evidence.callbacks.filter((row) => /collective-(?:accept|continue)-work$/.test(row.path)).length,
      decisionsBefore,
    );
    evidence.scenarios.push({ name: body, state: 'no new Work', requestEventId: request.eventId });
  }
  assert.ok(evidence.callbacks.some((row) => row.path === '/api/callbacks/collective-progress' && row.status === 200));
  assert.ok(evidence.agentVerifications.some((row) => row.accepted && row.turnStatus === 'running'));
  evidence.modelInvocations = verifiedModelInvocations(evidence, config.defaultModel);
  evidence.diskRecovery = await world.verifyDiskRecovery();
  evidence.outcome = 'all required core scenarios passed';
} catch (error) {
  failure = error;
  evidence.outcome = 'blocked or failed real-model run';
  evidence.failure = { name: error.name, code: error.code, message: error.message };
} finally {
  clearTimeout(timer);
  if (world) {
    evidence.finalWorks = world.works();
    evidence.serviceEvents = await world.store.listEventsForHuman(world.a.sessionToken, world.coordinates.collectiveId);
  }
  evidence.hostSnapshots = await Promise.all(hosts.map((host) => host.snapshot()));
  captureModelObservations(evidence, config.defaultModel);
  evidence.executableFingerprintAtFinish = await executableFingerprint(repo);
  evidence.executableCodeUnchanged =
    JSON.stringify(evidence.executableFingerprintAtStart) === JSON.stringify(evidence.executableFingerprintAtFinish);
  evidence.finishedAt = new Date().toISOString();
  evidence.elapsedMs = Date.now() - Date.parse(startedAt);
  evidence.uniqueInvocationIds = [
    ...new Set(
      [
        ...evidence.callbacks.map((row) => row.invocationId),
        ...evidence.frames.map((row) => row.turnInvocationId),
      ].filter(Boolean),
    ),
  ];
  evidence.boundaries = {
    trueHumanOAuth: false,
    indexStartup: false,
    realProvider: true,
    relayScenario: 'not attempted in this driver',
    redis: 'fresh canonical isolated server; separate Host databases; no protected ports',
    persistence:
      'Service/Connectors on dedicated disk; Host state in production Redis adapters during this isolated server lifetime',
  };
  const evidenceDirectory = resolve(process.env.F290_REAL_MODEL_EVIDENCE_DIR);
  await mkdir(evidenceDirectory, { recursive: true });
  const safe = safeEvidence(evidence);
  await writeFile(join(evidenceDirectory, 'run.json'), `${JSON.stringify(safe, null, 2)}\n`);
  console.log(
    JSON.stringify({
      stage: 'finished',
      outcome: evidence.outcome,
      elapsedMs: evidence.elapsedMs,
      invocations: evidence.uniqueInvocationIds.length,
      evidenceDirectory,
      failure: evidence.failure,
    }),
  );
  for (const host of hosts) await host.close().catch(() => {});
  await world?.close().catch(() => {});
}
process.exit(failure ? 1 : 0);
