import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import {
  type FootballComponentV1,
  type FootballModelComponentV1,
  MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID,
  type MicroduckFootballArchiveEvidence,
  type MicroduckFootballPackageV1,
  microduckFootballArchiveSchema,
  microduckFootballPackageSchema,
} from './archive-schema.js';

export {
  type FootballComponentV1,
  type FootballModelComponentV1,
  MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID,
  type MicroduckFootballPackageV1,
} from './archive-schema.js';

const OWNER_FEATURE_ID = 'microduck-owner';
const CONTROLLER_PATHS = {
  approach: 'football/approach_controller.py',
  arc: 'football/arc_controller.py',
  path: 'football/arc_path.py',
  safetyGuard: 'football/football_contract.py',
  runner: 'bin/microduck_control_runner.py',
} as const;

export type MicroduckFootballPackageNormalization =
  | {
      readonly status: 'resolved';
      readonly selection: 'unselected';
      readonly package: MicroduckFootballPackageV1;
      readonly packageBytes: Uint8Array;
      readonly packageRef: ExactAssetVersionRefV1;
    }
  | {
      readonly status: 'blocked';
      readonly code: 'football_package_evidence_invalid' | 'football_package_configuration_ambiguous';
    };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export const canonicalFootballJson = (value: unknown): string => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

export const footballSha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function validateMicroduckFootballPackage(input: unknown): MicroduckFootballPackageV1 | undefined {
  const parsed = microduckFootballPackageSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function createMicroduckFootballPackageRef(value: MicroduckFootballPackageV1): ExactAssetVersionRefV1 {
  const digest = footballSha256(canonicalFootballJson(value));
  return {
    ownerFeatureId: OWNER_FEATURE_ID,
    ownerStateRef: `control-package:sha256:${digest}`,
    version: digest,
    assetKind: 'control-package',
    assetId: MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID,
  };
}

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalFootballJson(left) === canonicalFootballJson(right);

function evidenceIsConsistent(value: MicroduckFootballArchiveEvidence): boolean {
  const { environment, models, plan, runtimeDependencies, codeFiles } = value;
  const modelNames = ['alpha_stand.onnx', 'alpha_walking.onnx', 'ball_kick_left.onnx', 'ball_kick_right.onnx'] as const;
  return (
    sameCanonicalValue(runtimeDependencies, environment.runtimeDependencies) &&
    modelNames.every((name) => plan.modelFiles[name] === models[name].sha256) &&
    environment.source.scenePath === plan.scenePath &&
    environment.source.sceneSha256 === plan.sceneFiles['scene_ball.xml'] &&
    Object.values(CONTROLLER_PATHS).every((path) => codeFiles[path] !== undefined)
  );
}

const model = (
  value: MicroduckFootballArchiveEvidence,
  name: keyof MicroduckFootballArchiveEvidence['models'],
): FootballModelComponentV1 => ({
  path: name,
  sha256: value.models[name].sha256,
  inputShape: value.models[name].input,
  outputShape: value.models[name].output,
});

function buildPackage(
  value: MicroduckFootballArchiveEvidence,
  kickDurationSeconds: number,
): MicroduckFootballPackageV1 {
  const { environment, plan, codeFiles } = value;
  const sceneDirectory = posix.dirname(plan.scenePath);
  return {
    schemaVersion: 1,
    artifactKind: 'microduck-control-package',
    capability: 'football',
    assetId: MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID,
    modelSet: {
      repository: plan.modelRepository,
      revision: plan.modelRevision,
      manifest: { path: 'manifest.json', sha256: plan.modelFiles['manifest.json'] },
      models: {
        stand: model(value, 'alpha_stand.onnx'),
        walk: model(value, 'alpha_walking.onnx'),
        kickLeft: model(value, 'ball_kick_left.onnx'),
        kickRight: model(value, 'ball_kick_right.onnx'),
      },
    },
    simulator: {
      repository: environment.source.repository,
      revision: environment.source.revision,
      scene: { path: plan.scenePath, sha256: plan.sceneFiles['scene_ball.xml'] },
      includes: {
        robotGroundContact: {
          path: posix.join(sceneDirectory, 'robot_groundcontact.xml'),
          sha256: plan.sceneFiles['robot_groundcontact.xml'],
        },
        ball: { path: posix.join(sceneDirectory, 'ball.xml'), sha256: plan.sceneFiles['ball.xml'] },
      },
      inferPolicy: {
        path: environment.source.inferPolicyPath,
        sha256: environment.source.inferPolicySha256,
      },
    },
    controller: {
      algorithm: plan.approachAlgorithm,
      implementation: {
        approach: { path: CONTROLLER_PATHS.approach, sha256: codeFiles[CONTROLLER_PATHS.approach] as string },
        arc: { path: CONTROLLER_PATHS.arc, sha256: codeFiles[CONTROLLER_PATHS.arc] as string },
        path: { path: CONTROLLER_PATHS.path, sha256: codeFiles[CONTROLLER_PATHS.path] as string },
        safetyGuard: {
          path: CONTROLLER_PATHS.safetyGuard,
          sha256: codeFiles[CONTROLLER_PATHS.safetyGuard] as string,
        },
      },
      config: plan.approachController,
      actionScale: plan.actionScale,
      kickDurationSeconds,
      observation: {
        layout: plan.observationLayout,
        policyInputShape: [1, 61],
        policyOutputShape: [1, 14],
        ballStateSource: 'mujoco_ground_truth',
        vision: false,
        observationNoise: false,
      },
      invocationInputs: {
        targetDirectionXY: 'runtime_nonzero_xy',
        kickFoot: 'runtime_left_or_right',
        activationDelaySeconds: 'runtime_nonnegative_seconds',
        scenarioRef: 'runtime_exact_owner_ref',
      },
      safety: { ballPlacement: 'reset_only', kickTriggerRelocatesBall: false },
    },
    runtime: {
      runner: { path: CONTROLLER_PATHS.runner, sha256: codeFiles[CONTROLLER_PATHS.runner] as string },
      dependencies: value.runtimeDependencies,
      controlHz: environment.episode.controlHz,
      physicsSubstepsPerControl: environment.episode.physicsSubstepsPerControl,
      physicsTimestepSeconds: environment.episode.physicsTimestepSeconds,
      actuator: environment.actuator,
      initialState: environment.initialState,
      policyObservation: environment.policyObservation,
    },
  };
}

export function normalizeMicroduckFootballArchive(input: unknown): MicroduckFootballPackageNormalization {
  const parsed = microduckFootballArchiveSchema.safeParse(input);
  if (!parsed.success || !evidenceIsConsistent(parsed.data)) {
    return { status: 'blocked', code: 'football_package_evidence_invalid' };
  }
  const durations = [...new Set(parsed.data.plan.cases.map((item) => item.kickSeconds))];
  if (durations.length !== 1) {
    return { status: 'blocked', code: 'football_package_configuration_ambiguous' };
  }
  const packageValue = buildPackage(parsed.data, durations[0] as number);
  const packageJson = canonicalFootballJson(packageValue);
  return {
    status: 'resolved',
    selection: 'unselected',
    package: packageValue,
    packageBytes: new TextEncoder().encode(packageJson),
    packageRef: createMicroduckFootballPackageRef(packageValue),
  };
}

export type MicroduckFootballComponentSource =
  | { readonly kind: 'model_repository'; readonly repository: string; readonly revision: string }
  | { readonly kind: 'simulator_repository'; readonly repository: string; readonly revision: string }
  | { readonly kind: 'owner_repository' };

export interface MicroduckFootballPackageComponent extends FootballComponentV1 {
  readonly id: string;
  readonly source: MicroduckFootballComponentSource;
}

export function listMicroduckFootballPackageComponents(
  value: MicroduckFootballPackageV1,
): MicroduckFootballPackageComponent[] {
  const modelSource = {
    kind: 'model_repository' as const,
    repository: value.modelSet.repository,
    revision: value.modelSet.revision,
  };
  const simulatorSource = {
    kind: 'simulator_repository' as const,
    repository: value.simulator.repository,
    revision: value.simulator.revision,
  };
  const ownerSource = { kind: 'owner_repository' as const };
  return [
    { id: 'model:manifest', ...value.modelSet.manifest, source: modelSource },
    { id: 'model:stand', ...value.modelSet.models.stand, source: modelSource },
    { id: 'model:walk', ...value.modelSet.models.walk, source: modelSource },
    { id: 'model:kick-left', ...value.modelSet.models.kickLeft, source: modelSource },
    { id: 'model:kick-right', ...value.modelSet.models.kickRight, source: modelSource },
    { id: 'simulator:scene', ...value.simulator.scene, source: simulatorSource },
    { id: 'simulator:robot-groundcontact', ...value.simulator.includes.robotGroundContact, source: simulatorSource },
    { id: 'simulator:ball', ...value.simulator.includes.ball, source: simulatorSource },
    { id: 'simulator:infer-policy', ...value.simulator.inferPolicy, source: simulatorSource },
    { id: 'controller:approach', ...value.controller.implementation.approach, source: ownerSource },
    { id: 'controller:arc', ...value.controller.implementation.arc, source: ownerSource },
    { id: 'controller:path', ...value.controller.implementation.path, source: ownerSource },
    { id: 'controller:safety-guard', ...value.controller.implementation.safetyGuard, source: ownerSource },
    { id: 'runtime:runner', ...value.runtime.runner, source: ownerSource },
  ];
}
