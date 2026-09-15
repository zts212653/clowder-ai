import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { inspectMicroduckFootballPackage } from '../dist/infrastructure/capability-evolution/adapters/microduck-football/integrity-loader.js';
import {
  createMicroduckFootballPackageRef,
  listMicroduckFootballPackageComponents,
  normalizeMicroduckFootballArchive,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-football/package.js';
import {
  createMicroduckFootballLoadedRuntimeRef,
  createMicroduckFootballRawAttemptRef,
  validateMicroduckFootballLoadedRuntime,
  validateMicroduckFootballRawAttempt,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-football/raw-attempt.js';
import { createMicroduckFootballArchiveFixture } from './fixtures/microduck-football-archive.fixture.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ownerRef = (prefix, fill) => ({
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: `${prefix}:sha256:${fill.repeat(64)}`,
  version: fill.repeat(64),
});

function resolved(value) {
  assert.equal(value.status, 'resolved');
  return value;
}

function setComponentDigest(target, id, digest) {
  const slots = {
    'model:manifest': target.modelSet.manifest,
    'model:stand': target.modelSet.models.stand,
    'model:walk': target.modelSet.models.walk,
    'model:kick-left': target.modelSet.models.kickLeft,
    'model:kick-right': target.modelSet.models.kickRight,
    'simulator:scene': target.simulator.scene,
    'simulator:robot-groundcontact': target.simulator.includes.robotGroundContact,
    'simulator:ball': target.simulator.includes.ball,
    'simulator:infer-policy': target.simulator.inferPolicy,
    'controller:approach': target.controller.implementation.approach,
    'controller:arc': target.controller.implementation.arc,
    'controller:path': target.controller.implementation.path,
    'controller:safety-guard': target.controller.implementation.safetyGuard,
    'runtime:runner': target.runtime.runner,
  };
  assert.ok(slots[id], `unexpected component ${id}`);
  slots[id].sha256 = digest;
}

async function syntheticFixture() {
  const normalized = resolved(await normalizeMicroduckFootballArchive(createMicroduckFootballArchiveFixture()));
  const packageValue = structuredClone(normalized.package);
  const bytes = new Map();
  for (const component of listMicroduckFootballPackageComponents(packageValue)) {
    const payload = Buffer.from(`fixture:${component.id}`);
    bytes.set(component.id, payload);
    setComponentDigest(packageValue, component.id, sha256(payload));
  }
  return {
    bytes,
    package: packageValue,
    packageRef: createMicroduckFootballPackageRef(packageValue),
  };
}

describe('F311 Microduck football package integrity loader', () => {
  it('resolves exact component bytes without manufacturing a runtime load', async () => {
    const fixture = await syntheticFixture();
    const result = await inspectMicroduckFootballPackage({
      package: fixture.package,
      packageRef: fixture.packageRef,
      supportedRuntime: fixture.package.runtime,
      readComponent: async ({ id }) => fixture.bytes.get(id),
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.componentCount, 14);
    assert.deepEqual(result.packageRef, fixture.packageRef);
    assert.match(result.runtimeAbiRef.ownerStateRef, /^runtime-abi:sha256:[a-f0-9]{64}$/u);
    assert.equal('loadedRuntimeRef' in result, false);
  });

  it('blocks missing, corrupt, incompatible, or mismatched package inputs', async () => {
    const fixture = await syntheticFixture();
    const [first] = listMicroduckFootballPackageComponents(fixture.package);

    assert.deepEqual(
      await inspectMicroduckFootballPackage({
        package: fixture.package,
        packageRef: fixture.packageRef,
        supportedRuntime: fixture.package.runtime,
        readComponent: async ({ id }) => (id === first.id ? undefined : fixture.bytes.get(id)),
      }),
      { status: 'blocked', code: 'football_component_unavailable', componentId: first.id },
    );

    assert.deepEqual(
      await inspectMicroduckFootballPackage({
        package: fixture.package,
        packageRef: fixture.packageRef,
        supportedRuntime: fixture.package.runtime,
        readComponent: async ({ id }) => (id === first.id ? Buffer.from('corrupt') : fixture.bytes.get(id)),
      }),
      { status: 'blocked', code: 'football_component_drift', componentId: first.id },
    );

    assert.deepEqual(
      await inspectMicroduckFootballPackage({
        package: fixture.package,
        packageRef: fixture.packageRef,
        supportedRuntime: { ...fixture.package.runtime, controlHz: 100 },
        readComponent: async ({ id }) => fixture.bytes.get(id),
      }),
      { status: 'blocked', code: 'football_runtime_incompatible' },
    );

    assert.deepEqual(
      await inspectMicroduckFootballPackage({
        package: fixture.package,
        packageRef: { ...fixture.packageRef, version: '0'.repeat(64) },
        supportedRuntime: fixture.package.runtime,
        readComponent: async ({ id }) => fixture.bytes.get(id),
      }),
      { status: 'blocked', code: 'football_package_ref_mismatch' },
    );

    const unsafePackage = structuredClone(fixture.package);
    unsafePackage.simulator.scene.path = '../../outside.xml';
    let unsafeReads = 0;
    assert.deepEqual(
      await inspectMicroduckFootballPackage({
        package: unsafePackage,
        packageRef: createMicroduckFootballPackageRef(unsafePackage),
        supportedRuntime: unsafePackage.runtime,
        readComponent: async ({ id }) => {
          unsafeReads += 1;
          return fixture.bytes.get(id);
        },
      }),
      { status: 'blocked', code: 'football_package_invalid' },
    );
    assert.equal(unsafeReads, 0);
  });
});

describe('F311 Microduck football goal-neutral execution evidence', () => {
  it('requires runtime load evidence and only admits raw attempts without measurement claims', async () => {
    const { packageRef, package: packageValue } = await syntheticFixture();
    const integrity = resolved(
      await inspectMicroduckFootballPackage({
        package: packageValue,
        packageRef,
        supportedRuntime: packageValue.runtime,
        readComponent: async (component) => Buffer.from(`fixture:${component.id}`),
      }),
    );
    const runtimeAbiRef = integrity.runtimeAbiRef;
    const loadEvidenceRef = ownerRef('load-evidence', 'e');
    const loadedAt = '2026-09-07T20:30:00.000Z';
    const loadedRuntimeRef = createMicroduckFootballLoadedRuntimeRef({
      packageRef,
      runtimeAbiRef,
      loadEvidenceRef,
      loadedAt,
    });
    const loaded = {
      schemaVersion: 1,
      status: 'loaded',
      packageRef,
      runtimeAbiRef,
      loadEvidenceRef,
      loadedAt,
      loadedRuntimeRef,
    };
    assert.deepEqual(validateMicroduckFootballLoadedRuntime(loaded, integrity), loaded);

    const invocation = {
      targetDirectionXY: [1, 0],
      kickFoot: 'left',
      activationDelaySeconds: 1,
      scenarioRef: ownerRef('scenario', 'f'),
    };
    const captureRef = ownerRef('capture', 'a');
    const operationRef = ownerRef('execution-operation', 'b');
    const recordedAt = '2026-09-07T20:31:00.000Z';
    const attemptRef = createMicroduckFootballRawAttemptRef({
      packageRef,
      loadedRuntimeRef,
      operationRef,
      invocation,
      captureRef,
      recordedAt,
    });
    const attempt = {
      schemaVersion: 1,
      status: 'recorded',
      claim: 'raw_execution_only',
      measurementRef: null,
      packageRef,
      loadedRuntimeRef,
      operationRef,
      invocation,
      captureRef,
      recordedAt,
      attemptRef,
    };
    assert.deepEqual(validateMicroduckFootballRawAttempt(attempt, loaded, integrity), attempt);
    assert.equal('freshnessProofRef' in attempt, false);
    assert.equal('restoreOutcomeRef' in attempt, false);

    assert.equal(
      validateMicroduckFootballLoadedRuntime({ ...loaded, loadEvidenceRef: undefined }, integrity),
      undefined,
    );
    assert.equal(
      validateMicroduckFootballRawAttempt(
        { ...attempt, status: 'fresh', freshnessProofRef: ownerRef('freshness-proof', 'c') },
        loaded,
        integrity,
      ),
      undefined,
    );
    assert.equal(
      validateMicroduckFootballRawAttempt(
        { ...attempt, measurementRef: ownerRef('measurement', 'd') },
        loaded,
        integrity,
      ),
      undefined,
    );

    const looseInvocation = {
      ...invocation,
      scenarioRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'scenario:loose' },
    };
    const looseAttempt = {
      ...attempt,
      invocation: looseInvocation,
      attemptRef: createMicroduckFootballRawAttemptRef({
        packageRef,
        loadedRuntimeRef,
        operationRef,
        invocation: looseInvocation,
        captureRef,
        recordedAt,
      }),
    };
    assert.equal(validateMicroduckFootballRawAttempt(looseAttempt, loaded, integrity), undefined);

    const wrongRuntimeAbiRef = ownerRef('runtime-abi', 'd');
    const wrongAbiLoaded = {
      ...loaded,
      runtimeAbiRef: wrongRuntimeAbiRef,
      loadedRuntimeRef: createMicroduckFootballLoadedRuntimeRef({
        packageRef,
        runtimeAbiRef: wrongRuntimeAbiRef,
        loadEvidenceRef,
        loadedAt,
      }),
    };
    assert.equal(validateMicroduckFootballLoadedRuntime(wrongAbiLoaded, integrity), undefined);
  });
});
