import { z } from 'zod';

export const MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID = 'football-forward-arc-csc' as const;
export const footballSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();
const xy = z.tuple([finite, finite]);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'expected a safe relative POSIX path',
  );

export const footballRuntimeDependenciesSchema = z
  .object({
    'better-actuator-models': z.string().min(1),
    mujoco: z.string().min(1),
    numpy: z.string().min(1),
    onnxruntime: z.string().min(1),
    pythonSeries: z.string().min(1),
  })
  .strict();

export const footballApproachControllerSchema = z
  .object({
    positionGain: positive,
    yawGain: positive,
    maxForwardMps: positive,
    maxLateralMps: positive,
    maxYawRadps: positive,
    minimumCommandMps: positive,
    positionToleranceM: z.tuple([positive, positive]),
    yawToleranceRad: positive,
    settlePositionToleranceM: z.tuple([positive, positive]),
    settleYawToleranceRad: positive,
    settleSeconds: positive,
    footOffsetM: xy,
    minimumForwardMps: positive,
    arc: z
      .object({
        radiusM: positive,
        stagingDistanceM: positive,
        clearanceM: positive,
        sampleStepM: positive,
        lookaheadM: positive,
        headingGain: positive,
        ballMovementToleranceM: nonNegative,
      })
      .strict(),
  })
  .strict();

export const footballComponentSchema = z.object({ path: relativePathSchema, sha256: footballSha256Schema }).strict();

export const footballModelComponentSchema = footballComponentSchema
  .extend({
    inputShape: z.tuple([z.literal(1), z.literal(61)]),
    outputShape: z.tuple([z.literal(1), z.literal(14)]),
  })
  .strict();

const modelHashesSchema = z
  .object({
    'alpha_stand.onnx': footballSha256Schema,
    'alpha_walking.onnx': footballSha256Schema,
    'ball_kick_left.onnx': footballSha256Schema,
    'ball_kick_right.onnx': footballSha256Schema,
    'manifest.json': footballSha256Schema,
  })
  .strict();

const sceneHashesSchema = z
  .object({
    'scene_ball.xml': footballSha256Schema,
    'robot_groundcontact.xml': footballSha256Schema,
    'ball.xml': footballSha256Schema,
  })
  .strict();

const modelEvidenceSchema = z
  .object({
    input: z.tuple([z.literal(1), z.literal(61)]),
    output: z.tuple([z.literal(1), z.literal(14)]),
    sha256: footballSha256Schema,
  })
  .strict();

const modelsSchema = z
  .object({
    'alpha_stand.onnx': modelEvidenceSchema,
    'alpha_walking.onnx': modelEvidenceSchema,
    'ball_kick_left.onnx': modelEvidenceSchema,
    'ball_kick_right.onnx': modelEvidenceSchema,
  })
  .strict();

export const footballRuntimeSourceSchema = z
  .object({
    repository: z.literal('pollen-robotics/microduck_rl'),
    revision: revisionSchema,
    inferPolicyPath: relativePathSchema,
    inferPolicySha256: footballSha256Schema,
    scenePath: relativePathSchema,
    sceneSha256: footballSha256Schema,
  })
  .strict();

export const footballActuatorSchema = z
  .object({
    bamModel: z.string().min(1),
    bamPackageSource: z.string().min(1),
    currentLimitAmp: finite.nullable(),
    kpFirmware: finite,
    motor: z.string().min(1),
    vinDropGain: finite,
    vinMin: finite,
    vinVolts: finite,
  })
  .strict();

export const footballInitialStateSchema = z
  .object({
    jointPose: z.string().min(1),
    trunkHeightMeters: positive,
    trunkQuaternionWxyz: z.tuple([finite, finite, finite, finite]),
  })
  .strict();

export const footballPolicyObservationSchema = z
  .object({
    commandDimensions: z.literal(13),
    lastAction: z.literal('raw_onnx_output_before_action_scale'),
    totalDimensions: z.literal(61),
    useProjectedGravity: z.literal(true),
  })
  .strict();

const runtimeEnvironmentSchema = z
  .object({
    source: footballRuntimeSourceSchema,
    runtimeDependencies: footballRuntimeDependenciesSchema,
    actuator: footballActuatorSchema,
    episode: z
      .object({
        controlHz: positive,
        durationSeconds: positive,
        measurementStartSeconds: nonNegative,
        physicsSubstepsPerControl: z.number().int().positive(),
        physicsTimestepSeconds: positive,
      })
      .strict(),
    initialState: footballInitialStateSchema,
    policyObservation: footballPolicyObservationSchema,
  })
  .passthrough();

const footballPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelRepository: z.literal('pollen-robotics/microduck-policies'),
    modelRevision: revisionSchema,
    modelFiles: modelHashesSchema,
    scenePath: relativePathSchema,
    sceneFiles: sceneHashesSchema,
    actionScale: positive,
    observationLayout: z.string().min(1),
    approachAlgorithm: z.literal('forward_arc_csc'),
    approachController: footballApproachControllerSchema,
    ballObservation: z.literal('MuJoCo ground truth; no vision/perception or observation noise'),
    ballPlacement: z.literal('fixed world coordinates at reset; kick trigger never relocates the ball'),
    newTraining: z.literal(false),
    cases: z
      .array(
        z
          .object({
            kickSeconds: positive,
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export const microduckFootballArchiveSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('microduck_football_preparation_probe'),
    plan: footballPlanSchema,
    environment: runtimeEnvironmentSchema,
    runtimeDependencies: footballRuntimeDependenciesSchema,
    models: modelsSchema,
    codeFiles: z.record(z.string(), footballSha256Schema),
  })
  .passthrough();

export const microduckFootballPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal('microduck-control-package'),
    capability: z.literal('football'),
    assetId: z.literal(MICRODUCK_FOOTBALL_PACKAGE_ASSET_ID),
    modelSet: z
      .object({
        repository: z.literal('pollen-robotics/microduck-policies'),
        revision: revisionSchema,
        manifest: footballComponentSchema,
        models: z
          .object({
            stand: footballModelComponentSchema,
            walk: footballModelComponentSchema,
            kickLeft: footballModelComponentSchema,
            kickRight: footballModelComponentSchema,
          })
          .strict(),
      })
      .strict(),
    simulator: z
      .object({
        repository: z.literal('pollen-robotics/microduck_rl'),
        revision: revisionSchema,
        scene: footballComponentSchema,
        includes: z
          .object({
            robotGroundContact: footballComponentSchema,
            ball: footballComponentSchema,
          })
          .strict(),
        inferPolicy: footballComponentSchema,
      })
      .strict(),
    controller: z
      .object({
        algorithm: z.literal('forward_arc_csc'),
        implementation: z
          .object({
            approach: footballComponentSchema,
            arc: footballComponentSchema,
            path: footballComponentSchema,
            safetyGuard: footballComponentSchema,
          })
          .strict(),
        config: footballApproachControllerSchema,
        actionScale: positive,
        kickDurationSeconds: positive,
        observation: z
          .object({
            layout: z.string().min(1),
            policyInputShape: z.tuple([z.literal(1), z.literal(61)]),
            policyOutputShape: z.tuple([z.literal(1), z.literal(14)]),
            ballStateSource: z.literal('mujoco_ground_truth'),
            vision: z.literal(false),
            observationNoise: z.literal(false),
          })
          .strict(),
        invocationInputs: z
          .object({
            targetDirectionXY: z.literal('runtime_nonzero_xy'),
            kickFoot: z.literal('runtime_left_or_right'),
            activationDelaySeconds: z.literal('runtime_nonnegative_seconds'),
            scenarioRef: z.literal('runtime_exact_owner_ref'),
          })
          .strict(),
        safety: z
          .object({
            ballPlacement: z.literal('reset_only'),
            kickTriggerRelocatesBall: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    runtime: z
      .object({
        runner: footballComponentSchema,
        dependencies: footballRuntimeDependenciesSchema,
        controlHz: positive,
        physicsSubstepsPerControl: z.number().int().positive(),
        physicsTimestepSeconds: positive,
        actuator: footballActuatorSchema,
        initialState: footballInitialStateSchema,
        policyObservation: footballPolicyObservationSchema,
      })
      .strict(),
  })
  .strict();

export type MicroduckFootballArchiveEvidence = z.infer<typeof microduckFootballArchiveSchema>;
export type MicroduckFootballApproachController = z.infer<typeof footballApproachControllerSchema>;
export type MicroduckFootballRuntimeDependencies = z.infer<typeof footballRuntimeDependenciesSchema>;
export type FootballComponentV1 = z.infer<typeof footballComponentSchema>;
export type FootballModelComponentV1 = z.infer<typeof footballModelComponentSchema>;
export type MicroduckFootballPackageV1 = z.infer<typeof microduckFootballPackageSchema>;
