const digest = (character) => character.repeat(64);
const revision = (character) => character.repeat(40);

export function createMicroduckFootballArchiveFixture() {
  const runtimeDependencies = {
    'better-actuator-models': '1.0.1',
    mujoco: '3.10.0',
    numpy: '2.4.1',
    onnxruntime: '1.24.4',
    pythonSeries: '3.12',
  };
  const scenePath = 'src/mjlab_microduck/robot/microduck/scene_ball.xml';
  const modelHashes = {
    'alpha_stand.onnx': digest('1'),
    'alpha_walking.onnx': digest('2'),
    'ball_kick_left.onnx': digest('3'),
    'ball_kick_right.onnx': digest('4'),
  };
  const sceneHashes = {
    'scene_ball.xml': digest('5'),
    'robot_groundcontact.xml': digest('6'),
    'ball.xml': digest('7'),
  };

  return {
    schemaVersion: 1,
    kind: 'microduck_football_preparation_probe',
    plan: {
      schemaVersion: 1,
      modelRepository: 'pollen-robotics/microduck-policies',
      modelRevision: revision('e'),
      modelFiles: { ...modelHashes, 'manifest.json': digest('0') },
      scenePath,
      sceneFiles: sceneHashes,
      actionScale: 1,
      observationLayout:
        '3 angular velocity + 3 projected gravity + 14 relative joint positions + 14 joint velocities + 14 previous raw actions + 13 command',
      approachAlgorithm: 'forward_arc_csc',
      approachController: {
        positionGain: 1.5,
        yawGain: 2,
        maxForwardMps: 0.25,
        maxLateralMps: 0.15,
        maxYawRadps: 0.8,
        minimumCommandMps: 0.06,
        positionToleranceM: [0.012, 0.012],
        yawToleranceRad: 0.12,
        settlePositionToleranceM: [0.03, 0.025],
        settleYawToleranceRad: 0.2,
        settleSeconds: 0.6,
        footOffsetM: [0.09, 0.042],
        minimumForwardMps: 0.25,
        arc: {
          radiusM: 0.22,
          stagingDistanceM: 0.16,
          clearanceM: 0.13,
          sampleStepM: 0.01,
          lookaheadM: 0.065,
          headingGain: 5,
          ballMovementToleranceM: 0.02,
        },
      },
      ballObservation: 'MuJoCo ground truth; no vision/perception or observation noise',
      ballPlacement: 'fixed world coordinates at reset; kick trigger never relocates the ball',
      newTraining: false,
      durationSeconds: 20,
      triggerSeconds: 1,
      targetDirectionXY: [1, 0],
      seedSet: { ref: 'seed-set:fixture' },
      cases: [{ id: 'left-far', behavior: 'kick_left', ballXY: [0.3, 0.2], kickSeconds: 0.5 }],
    },
    environment: {
      source: {
        repository: 'pollen-robotics/microduck_rl',
        revision: revision('f'),
        inferPolicyPath: 'scripts/infer_policy.py',
        inferPolicySha256: digest('8'),
        scenePath,
        sceneSha256: sceneHashes['scene_ball.xml'],
      },
      runtimeDependencies: { ...runtimeDependencies },
      actuator: {
        bamModel: 'm6',
        bamPackageSource: 'pypi:better-actuator-models@1.0.1',
        currentLimitAmp: null,
        kpFirmware: 200,
        motor: 'xl330',
        vinDropGain: 0.1,
        vinMin: 6,
        vinVolts: 7.4,
      },
      episode: {
        controlHz: 50,
        durationSeconds: 20,
        measurementStartSeconds: 1,
        physicsSubstepsPerControl: 4,
        physicsTimestepSeconds: 0.005,
      },
      initialState: {
        jointPose: 'infer_policy.DEFAULT_POSE',
        trunkHeightMeters: 0.125,
        trunkQuaternionWxyz: [1, 0, 0, 0],
      },
      policyObservation: {
        commandDimensions: 13,
        lastAction: 'raw_onnx_output_before_action_scale',
        totalDimensions: 61,
        useProjectedGravity: true,
      },
    },
    runtimeDependencies,
    models: Object.fromEntries(
      Object.entries(modelHashes).map(([name, sha256]) => [name, { input: [1, 61], output: [1, 14], sha256 }]),
    ),
    codeFiles: {
      'football/approach_controller.py': digest('9'),
      'football/arc_controller.py': digest('a'),
      'football/arc_path.py': digest('b'),
      'football/football_contract.py': digest('c'),
      'bin/microduck_control_runner.py': digest('d'),
    },
    episodes: [{ id: 'fixture-episode' }],
  };
}
