import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  createFileMeetingIntakeStateStore,
  FeishuCatchUpRequiredError,
  meetingIntakeStatePath,
} from '@clowder-ai/feishu-meeting-intake';
import { OFFICIAL_PLUGIN_CATALOG } from '../dist/domains/plugin/official-catalog.js';
import { OfficialPluginMeetingIntakeService } from '../dist/domains/plugin/official-plugin-meeting-intake.js';

const entry = OFFICIAL_PLUGIN_CATALOG[0];
const instance = {
  pluginInstanceId: 'pi_feishu_health',
  pluginId: entry.pluginId,
  packageDigest: entry.packageDigest,
  grantRevision: 1,
  lifecycleState: 'installed',
  configReadiness: 'ready',
  activationState: 'disabled',
  runtimeState: 'stopped',
  lifecycleRevision: 3,
  installedAt: 100,
  updatedAt: 100,
};

const artifact = (id) => ({
  artifactId: id,
  kind: 'minute',
  revision: '1',
  generatedAt: '2026-08-23T08:00:00Z',
  title: `Recovered ${id}`,
});

test('projects durable observation/publication health and stale recovery guidance', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'host-intake-health-'));
  const store = createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId));
  await store.commitPage(null, 'poll-v1:1000', [], 1_000);
  const service = new OfficialPluginMeetingIntakeService({
    homeDirectory,
    now: () => 200_000,
    staleAfterMs: 120_000,
    createGateway: () => {
      throw new Error('projection must not start a gateway');
    },
  });

  const projection = await service.project(entry, instance);

  assert.equal(projection.lastSuccessfulObservationAt, 1_000);
  assert.equal(projection.lastPublishedAt, null);
  assert.equal(projection.pendingCount, 0);
  assert.deepEqual(projection.warning, {
    code: 'OBSERVATION_STALE',
    message: '飞书会议纪要同步停用后存在时间缺口，请先检查并预览再恢复。',
    action: 'preview-catch-up',
  });
});

test('projects the live alpha.7 v1 cursor as unknown observation without rewriting it', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'host-intake-v1-'));
  const statePath = meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId);
  await mkdir(dirname(statePath), { recursive: true });
  const legacy = {
    v: 1,
    cursor: 'poll-v1:1000',
    pending: [],
    health: { status: 'ready' },
  };
  await writeFile(statePath, JSON.stringify(legacy), 'utf8');
  const service = new OfficialPluginMeetingIntakeService({ homeDirectory, now: () => 5_200 });

  const projection = await service.project(entry, instance);

  assert.equal(projection.warning.code, 'OBSERVATION_UNKNOWN');
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy);
});

test('detect and preview freeze the old cursor without starting normal polling', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'host-intake-preview-'));
  const store = createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId));
  await store.commitPage(null, 'poll-v1:1000', [], 1_000);
  let normalPolls = 0;
  let scans = 0;
  const service = new OfficialPluginMeetingIntakeService({
    homeDirectory,
    now: () => 5_200,
    createGateway: () => ({
      start: async () => undefined,
      detectCatchUpRequirement: async ({ cursor }) => {
        throw new FeishuCatchUpRequiredError({
          fromCursor: cursor,
          throughCursor: 'poll-v1:5000',
          reason: 'CURSOR_GAP',
        });
      },
      listGeneratedArtifacts: async () => {
        normalPolls += 1;
        return { artifacts: [], nextCursor: null };
      },
      inspectArtifact: async () => {
        throw new Error('not used');
      },
      scanGeneratedArtifacts: async ({ throughCursor }) => {
        scans += 1;
        return { artifacts: [artifact('one'), artifact('two')], nextCursor: throughCursor };
      },
      close: async () => undefined,
    }),
  });

  const preview = await service.preview(entry, instance);

  assert.equal(preview.candidateCount, 2);
  assert.equal(scans, 1);
  assert.equal(normalPolls, 0);
  const projected = await createFileMeetingIntakeStateStore(
    meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId),
  ).load();
  assert.equal(projected.catchUp.status, 'previewed');
  assert.deepEqual(projected.pending, []);
});

test('replay bridges the preview fence into the package outbox exactly once', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'host-intake-replay-'));
  const store = createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId));
  await store.requireCatchUp({
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  const gateway = {
    start: async () => undefined,
    detectCatchUpRequirement: async () => undefined,
    listGeneratedArtifacts: async () => ({ artifacts: [], nextCursor: null }),
    inspectArtifact: async () => {
      throw new Error('not used');
    },
    scanGeneratedArtifacts: async ({ throughCursor }) => ({
      artifacts: [artifact('one')],
      nextCursor: throughCursor,
    }),
    close: async () => undefined,
  };
  const service = new OfficialPluginMeetingIntakeService({
    homeDirectory,
    now: () => 5_200,
    createGateway: () => gateway,
  });
  const preview = await service.preview(entry, instance);

  const resolved = await service.resolve(entry, instance, {
    action: 'replay',
    fingerprint: preview.fingerprint,
  });

  assert.deepEqual(resolved, { action: 'replay', candidateCount: 1 });
  assert.equal(
    (await createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId)).load())
      .pending.length,
    1,
  );
  await assert.rejects(
    service.resolve(entry, instance, { action: 'replay', fingerprint: preview.fingerprint }),
    /previewable owner decision window/,
  );
  assert.equal(
    (await createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId)).load())
      .pending.length,
    1,
  );
});

test('replay keeps scanner failures distinct from a changed preview', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'host-intake-replay-failure-'));
  const store = createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId));
  await store.requireCatchUp({
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  let scans = 0;
  const service = new OfficialPluginMeetingIntakeService({
    homeDirectory,
    now: () => 5_200,
    createGateway: () => ({
      start: async () => undefined,
      detectCatchUpRequirement: async () => undefined,
      listGeneratedArtifacts: async () => ({ artifacts: [], nextCursor: null }),
      inspectArtifact: async () => {
        throw new Error('not used');
      },
      scanGeneratedArtifacts: async ({ throughCursor }) => {
        scans += 1;
        if (scans > 1) throw new Error('scanner network unavailable');
        return { artifacts: [artifact('one')], nextCursor: throughCursor };
      },
      close: async () => undefined,
    }),
  });
  const preview = await service.preview(entry, instance);

  await assert.rejects(
    service.resolve(entry, instance, { action: 'replay', fingerprint: preview.fingerprint }),
    /scanner network unavailable/,
  );
});

test('projects bounded scanner overflow as explicit owner backlog', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'host-intake-backlog-'));
  const store = createFileMeetingIntakeStateStore(meetingIntakeStatePath(homeDirectory, instance.pluginInstanceId));
  await store.requireCatchUp({
    fromCursor: 'poll-v1:1000',
    throughCursor: 'poll-v1:5000',
    reason: 'CURSOR_GAP',
    detectedAt: 5_100,
  });
  const service = new OfficialPluginMeetingIntakeService({
    homeDirectory,
    now: () => 5_200,
    createGateway: () => ({
      start: async () => undefined,
      detectCatchUpRequirement: async () => undefined,
      listGeneratedArtifacts: async () => ({ artifacts: [], nextCursor: null }),
      inspectArtifact: async () => {
        throw new Error('not used');
      },
      scanGeneratedArtifacts: async ({ fromCursor, throughCursor }) => {
        throw new FeishuCatchUpRequiredError({
          fromCursor,
          throughCursor,
          reason: 'PAGE_BOUND',
          candidateCountAtLeast: 121,
        });
      },
      close: async () => undefined,
    }),
  });

  await assert.rejects(service.preview(entry, instance), (error) => error?.code === 'CATCH_UP_BACKLOG');
  const projection = await service.project(entry, instance);
  assert.equal(projection.catchUp.status, 'backlog');
  assert.equal(projection.warning.code, 'CATCH_UP_BACKLOG');
  assert.equal(projection.warning.action, 'needs-owner');
});
