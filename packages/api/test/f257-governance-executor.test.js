import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import YAML from 'yaml';

const { HarnessGovernanceExecutor } = await import(
  '../dist/infrastructure/harness-eval/governance/HarnessGovernanceExecutor.js'
);
const { HarnessUnitDirectoryWriter } = await import(
  '../dist/infrastructure/harness-eval/governance/HarnessUnitDirectoryWriter.js'
);

const roots = [];
const VERSION_STATE = {
  triggerPolicy: {
    cumulativeThreshold: 200,
    counterexampleThreshold: 3,
    cadenceDays: 7,
    minimumIntervalMs: 7_200_000,
    consecutiveKeepCycles: 0,
    consecutiveCadenceKeepCycles: 0,
  },
  lifecycle: 'active',
};
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'f257-governance-executor-'));
  roots.push(root);
  await mkdir(join(root, 'assets', 'prompt-hooks', 'd1-existing'), { recursive: true });
  await mkdir(join(root, 'docs', 'harness-feedback', 'objectives'), { recursive: true });
  const templatePath = join(root, 'assets', 'prompt-hooks', 'd1-existing', 'd1.md');
  await writeFile(templatePath, 'v1 body');
  await writeFile(
    join(root, 'docs', 'harness-feedback', 'objectives', 'unit-evaluation-manifest.yaml'),
    YAML.stringify({
      manifestVersion: 1,
      registryVersion: 2,
      units: [
        {
          unitId: 'D1',
          hookId: 'd1-existing',
          unitState: 'evaluable',
          objectives: [{ objectiveId: 'obj' }],
        },
      ],
    }),
  );
  const manifest = {
    id: 'D1',
    name: 'Existing',
    stage: 'per-turn',
    order: 100,
    version: 1,
    enabled: true,
    template: 'd1.md',
    inputs: [],
    disableable: true,
    safetyTier: 'editable',
    transparencyTier: 'visible-by-default',
    governanceTier: 'auto-evolve',
  };
  const catalog = {
    registry: { objectives: [{ id: 'obj' }] },
    manifest: {
      units: [
        {
          unitId: 'D1',
          hookId: 'd1-existing',
          unitState: 'evaluable',
          objectives: [{ objectiveId: 'obj' }],
        },
      ],
    },
  };
  const hooks = new Map([['D1', { manifest, templatePath }]]);
  const versions = new Map([['D1', 1]]);
  const content = new Map();
  const conditions = new Map();
  const enabled = new Map([['D1', true]]);
  const registry = {
    getHook: (id) => hooks.get(id),
    getStageHooks: (stage) => [...hooks.values()].filter((hook) => hook.manifest.stage === stage),
    isEnabled: (id) => enabled.get(id) ?? hooks.get(id)?.manifest.enabled ?? false,
    getActiveVersion: (id) => versions.get(id) ?? hooks.get(id)?.manifest.version ?? 0,
    getContentOverride: (id) => content.get(id),
    getConditionOverride: (id) => conditions.get(id),
  };
  const writes = [];
  const overrideStore = {
    async getOverride(id) {
      return enabled.has(id) ? { enabled: enabled.get(id) } : null;
    },
    async getActiveVersion(id) {
      return versions.get(id) ?? 0;
    },
    async getVersionContent(id, version) {
      return id === 'D1' && version === 1 ? 'v1 body' : null;
    },
    async disable(id) {
      writes.push(['disable', id]);
      enabled.set(id, false);
    },
    async enable(id) {
      writes.push(['enable', id]);
      enabled.set(id, true);
    },
    async setContentOverride(id, value) {
      writes.push(['modify', id, value]);
      content.set(id, value);
      versions.set(id, (versions.get(id) ?? 1) + 1);
    },
    async setConditionOverride(id, value) {
      writes.push(['condition', id, value]);
      conditions.set(id, value);
    },
    async clearConditionOverride(id) {
      writes.push(['condition-clear', id]);
      conditions.delete(id);
    },
    async activateVersion(id, version) {
      writes.push(['rollback', id, version]);
      content.set(id, 'v1 body');
      versions.set(id, version);
    },
  };
  const writer = new HarnessUnitDirectoryWriter({ projectRoot: root, catalog });
  let reloads = 0;
  const executor = new HarnessGovernanceExecutor({
    catalog,
    overrideStore,
    getRegistry: () => registry,
    unitWriter: writer,
    async reloadPipeline() {
      reloads++;
      for (const added of catalog.manifest.units.filter((unit) => !hooks.has(unit.unitId))) {
        const addedManifest = YAML.parse(
          await readFile(join(root, 'assets', 'prompt-hooks', added.hookId, 'hook.yaml'), 'utf8'),
        );
        hooks.set(added.unitId, {
          manifest: addedManifest,
          templatePath: join(root, 'assets', 'prompt-hooks', added.hookId, addedManifest.template),
        });
        versions.set(added.unitId, 1);
      }
    },
    async resolveObjectiveVersion(objectiveId) {
      const refs = catalog.manifest.units
        .filter((unit) => unit.objectives.some((objective) => objective.objectiveId === objectiveId))
        .map((unit) => `${unit.unitId}@${versions.get(unit.unitId) ?? 1}`)
        .sort();
      return { version: `objective-${refs.join('-')}`, versionContentRef: `objective-versions:${refs.join(',')}` };
    },
  });
  return { root, catalog, executor, overrideStore, writes, reloads: () => reloads };
}

const proposal = (changes) => ({
  proposalId: 'HGP-1',
  ownerUserId: 'owner-1',
  objectiveId: 'obj',
  changes,
});

describe('F257 Harness governance executor', () => {
  test('hydrates canonical unit ids and applies a human-approved overlay before one reload', async () => {
    const context = await harness();
    const changes = await context.executor.hydrate('obj', {
      objectiveId: 'obj',
      cycleId: 'cycle-1',
      decision: 'evolve',
      reason: 'Tighten it.',
      v2Draft: {
        changes: [{ action: 'modify', unitId: 'D1', reason: 'Remove ambiguity.', proposedContent: 'v2 body' }],
      },
    });
    assert.equal(changes[0].hookId, 'D1', 'catalog asset slug must never replace the canonical registry id');
    assert.equal(changes[0].beforeContent, 'v1 body');

    const version = await context.executor.apply(proposal(changes), 'owner-1', 'Approved.', VERSION_STATE);
    assert.deepEqual(context.writes, [['modify', 'D1', 'v2 body']]);
    assert.equal(context.reloads(), 1);
    assert.match(version.versionContentRef, /D1@2/);
  });

  test('materializes an approved new unit into the scanned directory and Objective manifest', async () => {
    const context = await harness();
    const unit = {
      unitId: 'X1',
      assetSlug: 'x1-new-rule',
      manifest: {
        id: 'X1',
        name: 'New rule',
        stage: 'per-turn',
        order: 200,
        version: 1,
        enabled: true,
        template: 'x1-new-rule.md',
        inputs: [],
        disableable: true,
        safetyTier: 'editable',
        transparencyTier: 'visible-by-default',
        governanceTier: 'auto-evolve',
      },
      content: 'new rule body',
      objectives: [{ objectiveId: 'obj' }],
    };
    const changes = await context.executor.hydrate('obj', {
      objectiveId: 'obj',
      cycleId: 'cycle-1',
      decision: 'evolve',
      reason: 'Add a missing guard.',
      v2Draft: { changes: [{ action: 'add', reason: 'Coverage gap.', unit }] },
    });
    const version = await context.executor.apply(proposal(changes), 'owner-1', 'Approved.', VERSION_STATE);

    assert.equal(
      await readFile(join(context.root, 'assets', 'prompt-hooks', 'x1-new-rule', 'x1-new-rule.md'), 'utf8'),
      'new rule body',
    );
    const manifest = YAML.parse(
      await readFile(
        join(context.root, 'docs', 'harness-feedback', 'objectives', 'unit-evaluation-manifest.yaml'),
        'utf8',
      ),
    );
    assert.equal(manifest.units.find((unitEntry) => unitEntry.unitId === 'X1').hookId, 'x1-new-rule');
    assert.match(version.versionContentRef, /D1@1,X1@1/);
    assert.equal(context.reloads(), 1);
  });

  test('serializes concurrent approved additions so the scanned manifest retains both units', async () => {
    const context = await harness();
    const unit = (unitId, order) => ({
      unitId,
      assetSlug: `${unitId.toLowerCase()}-new-rule`,
      manifest: {
        id: unitId,
        name: `New rule ${unitId}`,
        stage: 'per-turn',
        order,
        version: 1,
        enabled: true,
        template: `${unitId.toLowerCase()}-new-rule.md`,
        inputs: [],
        disableable: true,
        safetyTier: 'editable',
        transparencyTier: 'visible-by-default',
        governanceTier: 'auto-evolve',
      },
      content: `new rule body ${unitId}`,
      objectives: [{ objectiveId: 'obj' }],
    });
    const drafts = await Promise.all(
      [unit('X1', 200), unit('X2', 201)].map((draft) =>
        context.executor.hydrate('obj', {
          objectiveId: 'obj',
          cycleId: 'cycle-1',
          decision: 'evolve',
          reason: 'Add missing guards.',
          v2Draft: { changes: [{ action: 'add', reason: 'Coverage gap.', unit: draft }] },
        }),
      ),
    );
    await Promise.all(
      drafts.map((changes) => context.executor.apply(proposal(changes), 'owner-1', 'Approved.', VERSION_STATE)),
    );

    const manifest = YAML.parse(
      await readFile(
        join(context.root, 'docs', 'harness-feedback', 'objectives', 'unit-evaluation-manifest.yaml'),
        'utf8',
      ),
    );
    assert.deepEqual(manifest.units.map((entry) => entry.unitId).sort(), ['D1', 'X1', 'X2']);
  });

  test('applies a whitelisted condition override without opening stage or order mutation', async () => {
    const context = await harness();
    const condition = { conditionRef: 'routing-mode-in', params: { values: ['serial'] } };
    const changes = await context.executor.hydrate('obj', {
      objectiveId: 'obj',
      cycleId: 'cycle-1',
      decision: 'evolve',
      reason: 'Narrow the injection surface.',
      v2Draft: { changes: [{ action: 'modify', unitId: 'D1', reason: 'Serial only.', proposedCondition: condition }] },
    });
    assert.equal(changes[0].proposedContent, undefined);
    assert.deepEqual(changes[0].proposedCondition, condition);

    await context.executor.apply(proposal(changes), 'owner-1', 'Approved.', VERSION_STATE);
    assert.deepEqual(context.writes, [['condition', 'D1', condition]]);
  });

  test('an apply that fails between two durable writes can be approved again', async () => {
    const context = await harness();
    const condition = { conditionRef: 'routing-mode-in', params: { values: ['serial'] } };
    const change = {
      action: 'modify',
      unitId: 'D1',
      hookId: 'D1',
      reason: 'Narrow the surface and rewrite the body.',
      sourceVersion: 1,
      beforeContent: 'v1 body',
      proposedContent: 'v2 body',
      beforeCondition: null,
      proposedCondition: condition,
    };

    // The content write lands; the condition write fails right after it.
    const realSetCondition = context.overrideStore.setConditionOverride;
    let conditionAttempts = 0;
    context.overrideStore.setConditionOverride = async (...args) => {
      conditionAttempts += 1;
      if (conditionAttempts === 1) throw new Error('redis_unavailable');
      return realSetCondition.apply(context.overrideStore, args);
    };

    await assert.rejects(
      context.executor.apply(proposal([change]), 'owner-1', 'Approved.', VERSION_STATE),
      /redis_unavailable/,
    );
    assert.deepEqual(
      context.writes,
      [['modify', 'D1', 'v2 body']],
      'the runtime is half-advanced: new body live, condition not',
    );

    // The proposal is still pending, so the operator approves it again. Reading
    // our own partial progress as drift would strand it here forever.
    await context.executor.apply(proposal([change]), 'owner-1', 'Approved.', VERSION_STATE);
    assert.deepEqual(context.writes, [
      ['modify', 'D1', 'v2 body'],
      ['condition', 'D1', condition],
    ]);
  });

  test('a unit that moved to a third value still fails closed on retry', async () => {
    const context = await harness();
    const change = {
      action: 'modify',
      unitId: 'D1',
      hookId: 'D1',
      reason: 'Rewrite the body.',
      sourceVersion: 1,
      beforeContent: 'v1 body',
      proposedContent: 'v2 body',
      beforeCondition: null,
    };
    // Someone else edited the unit to content this proposal never asked for.
    await context.overrideStore.setContentOverride('D1', 'someone else body', 'other');
    context.writes.length = 0;

    await assert.rejects(
      context.executor.apply(proposal([change]), 'owner-1', 'Approved.', VERSION_STATE),
      /harness_governance_source_version_changed/,
    );
    assert.deepEqual(context.writes, [], 'resumability must not weaken drift detection');
  });

  test('preflights every action before the first mutation', async () => {
    const context = await harness();
    const changes = [
      {
        action: 'modify',
        unitId: 'D1',
        hookId: 'D1',
        reason: 'Would otherwise write first.',
        sourceVersion: 1,
        beforeContent: 'v1 body',
        proposedContent: 'v2 body',
        beforeCondition: null,
      },
      {
        action: 'add',
        unitId: 'X1',
        hookId: 'X1',
        assetSlug: 'x1-conflict',
        reason: 'Conflicts with D1 order.',
        manifest: {
          id: 'X1',
          name: 'Conflict',
          stage: 'per-turn',
          order: 100,
          version: 1,
          enabled: true,
          template: 'x1-conflict.md',
          inputs: [],
          disableable: true,
          safetyTier: 'editable',
          transparencyTier: 'visible-by-default',
          governanceTier: 'auto-evolve',
        },
        content: 'conflict',
        objectives: [{ objectiveId: 'obj' }],
      },
    ];
    await assert.rejects(
      context.executor.apply(proposal(changes), 'owner-1', 'Approved.', VERSION_STATE),
      /cycle_governance_add_registry_conflict/,
    );
    assert.deepEqual(context.writes, []);
  });

  test('preflight rejects two additions that claim the same stage/order', async () => {
    const context = await harness();
    const addition = (unitId, assetSlug) => ({
      action: 'add',
      unitId,
      hookId: unitId,
      assetSlug,
      reason: 'Add one guard.',
      manifest: {
        id: unitId,
        name: unitId,
        stage: 'per-turn',
        order: 200,
        version: 1,
        enabled: true,
        template: `${assetSlug}.md`,
        inputs: [],
        disableable: true,
        safetyTier: 'editable',
        transparencyTier: 'visible-by-default',
        governanceTier: 'auto-evolve',
      },
      content: `${unitId} body`,
      objectives: [{ objectiveId: 'obj' }],
    });
    await assert.rejects(
      context.executor.apply(
        proposal([addition('X1', 'x1-new-rule'), addition('X2', 'x2-new-rule')]),
        'owner-1',
        'Approved.',
        VERSION_STATE,
      ),
      /cycle_governance_add_registry_conflict/,
    );
    await assert.rejects(() => readFile(join(context.root, 'assets', 'prompt-hooks', 'x1-new-rule', 'hook.yaml')));
  });
});
