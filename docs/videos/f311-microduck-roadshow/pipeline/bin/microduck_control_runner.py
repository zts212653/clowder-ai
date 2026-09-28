#!/usr/bin/env python3
"""Seeded whole-body CPU evaluator for a fixed Microduck ONNX policy.

The runner imports the exact upstream ``infer_policy.py`` selected by the
pre-registration.  That keeps the 61D observation, raw-action history and BAM
actuator semantics on the official implementation while replacing its
interactive viewer and unseeded keyboard shove with a headless seeded loop.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
from importlib.metadata import version
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from statistics import fmean, stdev


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, separators=(",", ": ")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> object:
    return json.loads(path.read_text())


def checked_file(path: Path, expected_sha256: str) -> bytes:
    payload = path.read_bytes()
    actual = sha256_bytes(payload)
    if actual != expected_sha256:
        raise ValueError(f"sha256 mismatch for {path}: expected {expected_sha256}, got {actual}")
    return payload


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"missing {name}")
    return value


def resolve_manifest_item(manifest_path: Path, item: dict) -> tuple[dict, dict, dict]:
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict):
        raise ValueError("control experiment manifest must be an object")
    subject = next((entry for entry in manifest["subjects"] if entry["id"] == item["subjectId"]), None)
    if subject is None:
        raise ValueError(f"unknown subject {item['subjectId']}")
    binding_fields = (
        "artifactRef", "artifactVersion", "policyRef", "policySha256", "configRef",
        "configSha256", "runnerRef", "evaluationEnvRef",
    )
    for field in binding_fields:
        expected = subject.get(field, manifest.get(field))
        if item.get(field) != expected:
            raise ValueError(f"plan binding mismatch for {field}")
    config_path = manifest_path.parent.parent / subject["configPath"]
    env_path = manifest_path.parent.parent / manifest["evaluationEnvPath"]
    config = read_json(config_path)
    environment = read_json(env_path)
    checked_file(config_path, subject["configSha256"])
    checked_file(env_path, manifest["evaluationEnvSha256"])
    return subject, config, environment


def resolve_seed_file(item: dict) -> tuple[list[int], str]:
    env_name = "F311_PUBLIC_SEED_FILE" if item["split"] == "public" else "F311_HOLDOUT_SEED_FILE"
    path = Path(require_env(env_name)).resolve()
    payload = checked_file(path, item["seedSetSha256"])
    document = json.loads(payload)
    seeds = document.get("seeds") if isinstance(document, dict) else None
    if not isinstance(seeds, list) or len(seeds) != item["seedCount"]:
        raise ValueError("seed file count does not match the bound plan")
    if any(not isinstance(seed, int) or seed < 0 or seed > 0xFFFFFFFF for seed in seeds):
        raise ValueError("seed file must contain uint32 values")
    return seeds, str(path)


def load_upstream(source_root: Path, environment: dict):
    source = environment["source"]
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=source_root, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    if revision != source["revision"]:
        raise ValueError(f"upstream revision drift: expected {source['revision']}, got {revision}")
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"], cwd=source_root, check=True,
        capture_output=True, text=True,
    ).stdout
    if status:
        raise ValueError("upstream checkout must be clean")
    script_path = source_root / source["inferPolicyPath"]
    scene_path = source_root / source["scenePath"]
    checked_file(script_path, source["inferPolicySha256"])
    checked_file(scene_path, source["sceneSha256"])
    spec = importlib.util.spec_from_file_location("f311_exact_infer_policy", script_path)
    if spec is None or spec.loader is None:
        raise ValueError("cannot import exact upstream infer_policy.py")
    module = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(module)
    return module, scene_path


def verify_runtime(environment: dict) -> dict:
    expected = environment["runtimeDependencies"]
    actual = {
        "better-actuator-models": version("better-actuator-models"),
        "mujoco": version("mujoco"),
        "numpy": version("numpy"),
        "onnxruntime": version("onnxruntime"),
        "pythonSeries": ".".join(sys.version.split()[0].split(".")[:2]),
    }
    if actual != expected:
        raise ValueError(f"runtime dependency drift: expected {expected}, got {actual}")
    return actual


def initialize_episode(ip, model, data, bam_ctrl, policy, environment: dict) -> tuple[int, int]:
    import mujoco
    import numpy as np

    mujoco.mj_resetData(model, data)
    freejoint = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "trunk_base_freejoint")
    qpos_adr = int(model.jnt_qposadr[freejoint])
    qvel_adr = int(model.jnt_dofadr[freejoint])
    initial = environment["initialState"]
    data.qpos[qpos_adr : qpos_adr + 3] = [0.0, 0.0, initial["trunkHeightMeters"]]
    data.qpos[qpos_adr + 3 : qpos_adr + 7] = initial["trunkQuaternionWxyz"]
    data.qvel[qvel_adr : qvel_adr + 6] = 0.0
    data.qpos[policy.joint_qpos_indices] = ip.DEFAULT_POSE
    bam_ctrl.reset(data.qpos)
    policy.last_action = np.zeros(policy.n_joints, dtype=np.float32)
    command = environment["command"]
    with contextlib.redirect_stdout(sys.stderr):
        policy.set_vel_cmd(
            command["linearXMetersPerSecond"],
            command["linearYMetersPerSecond"],
            command["angularZRadiansPerSecond"],
        )
    policy.set_position_targets(policy.default_pose)
    mujoco.mj_forward(model, data)
    return qpos_adr, qvel_adr


def body_forward_velocity(ip, data, qpos_adr: int, qvel_adr: int) -> float:
    import numpy as np

    quat = data.qpos[qpos_adr + 3 : qpos_adr + 7].astype(np.float32)
    world_velocity = data.qvel[qvel_adr : qvel_adr + 3].astype(np.float32)
    return float(ip.PolicyInference.quat_rotate_inverse(None, quat, world_velocity)[0])


def run_episode(ip, model, data, bam_ctrl, policy, environment: dict, seed: int, seed_ordinal: int) -> dict:
    import mujoco
    import numpy as np

    qpos_adr, qvel_adr = initialize_episode(ip, model, data, bam_ctrl, policy, environment)
    episode = environment["episode"]
    fall = environment["fall"]
    push = environment["perturbation"]
    total_ticks = round(episode["durationSeconds"] * episode["controlHz"])
    measurement_tick = round(episode["measurementStartSeconds"] * episode["controlHz"])
    measurement_samples = total_ticks - measurement_tick + 1
    push_ticks = {round(value * episode["controlHz"]): index for index, value in enumerate(push["timesSeconds"])}
    rng = np.random.Generator(np.random.PCG64(seed))
    push_vectors = rng.uniform(
        push["minimumMetersPerSecond"], push["maximumMetersPerSecond"],
        size=(len(push_ticks), 2),
    )
    start_x = None
    errors = []
    fall_streak = 0
    fallen_at = None
    fall_state = None
    applied_pushes = []
    trace = []
    command_x = environment["command"]["linearXMetersPerSecond"]

    for tick in range(total_ticks):
        if tick in push_ticks:
            vector = push_vectors[push_ticks[tick]]
            data.qvel[qvel_adr] += vector[0]
            data.qvel[qvel_adr + 1] += vector[1]
            applied_pushes.append({"tick": tick, "deltaWorldX": float(vector[0]), "deltaWorldY": float(vector[1])})
        action = policy.infer()
        policy.apply_action(action)
        for _ in range(episode["physicsSubstepsPerControl"]):
            bam_ctrl.update()
            mujoco.mj_step(model, data)

        elapsed = (tick + 1) / episode["controlHz"]
        position_x = float(data.qpos[qpos_adr])
        trunk_z = float(data.qpos[qpos_adr + 2])
        projected_gravity_z = float(policy.get_projected_gravity()[2])
        forward_velocity = body_forward_velocity(ip, data, qpos_adr, qvel_adr)
        if tick + 1 == measurement_tick:
            start_x = position_x
        if tick + 1 >= measurement_tick:
            errors.append(abs(forward_velocity - command_x))
        unhealthy = (
            not np.isfinite(data.qpos).all()
            or projected_gravity_z > fall["projectedGravityZGreaterThan"]
            or trunk_z < fall["trunkHeightMetersLessThan"]
        )
        fall_streak = fall_streak + 1 if unhealthy else 0
        trace.append([
            tick + 1, round(elapsed, 6), position_x, trunk_z,
            projected_gravity_z, forward_velocity, fall_streak,
        ])
        if fall_streak >= fall["debounceControlSteps"]:
            fallen_at = elapsed
            fall_state = {"trunkHeightMeters": trunk_z, "projectedGravityZ": projected_gravity_z}
            if start_x is None:
                # A pre-window fall stays at its terminal pose for scoring: zero
                # post-warmup distance and command-sized velocity error.
                start_x = position_x
            errors.extend([abs(command_x)] * (measurement_samples - len(errors)))
            break

    if start_x is None or len(errors) != measurement_samples:
        raise RuntimeError("episode did not produce the frozen measurement window")
    end_x = float(data.qpos[qpos_adr])
    return {
        "seedOrdinal": seed_ordinal,
        "survived": fallen_at is None,
        "fallenAtSeconds": fallen_at,
        "fallState": fall_state,
        "measurement": {
            "forwardDistanceM": end_x - start_x,
            "meanAbsVelocityErrorMps": fmean(errors),
            "sampleCount": len(errors),
            "startWorldXM": start_x,
            "endWorldXM": end_x,
        },
        "pushes": applied_pushes,
        "traceColumns": ["tick", "seconds", "worldXM", "trunkHeightM", "projectedGravityZ", "bodyForwardVelocityMps", "fallStreak"],
        "trace": trace,
    }


def estimate(values: list[float]) -> dict:
    return {"estimate": fmean(values), "standardError": stdev(values) / math.sqrt(len(values))}


def run(item: dict) -> dict:
    import mujoco

    manifest_path = Path(require_env("F311_CONTROL_EXPERIMENT_FILE")).resolve()
    subject, config, environment = resolve_manifest_item(manifest_path, item)
    seeds, _ = resolve_seed_file(item)
    source_root = Path(require_env("F311_MICRODUCK_SOURCE_ROOT")).resolve()
    onnx_path = Path(require_env("F311_MICRODUCK_ONNX_FILE")).resolve()
    checked_file(onnx_path, item["policySha256"])
    runtime_dependencies = verify_runtime(environment)
    ip, scene_path = load_upstream(source_root, environment)
    actuator = environment["actuator"]
    with contextlib.redirect_stdout(sys.stderr):
        bam_model = ip.load_bam_model(actuator["kpFirmware"], actuator["vinVolts"], actuator["currentLimitAmp"])
        model, data, bam_ctrl, _ = ip.load_mujoco_with_bam(
            str(scene_path), bam_model, environment["episode"]["physicsTimestepSeconds"],
            actuator["vinDropGain"], actuator["vinMin"],
        )
        policy = ip.PolicyInference(
            model, data, walking_onnx_path=str(onnx_path), action_scale=config["actionScale"],
            bam_ctrl=bam_ctrl, use_projected_gravity=True, new_cmd_obs=True,
        )
    episodes = [
        run_episode(ip, model, data, bam_ctrl, policy, environment, seed, ordinal)
        for ordinal, seed in enumerate(seeds, start=1)
    ]
    metrics = {
        "meanAbsVelocityErrorMps": estimate([entry["measurement"]["meanAbsVelocityErrorMps"] for entry in episodes]),
        "meanForwardDistanceM": estimate([entry["measurement"]["forwardDistanceM"] for entry in episodes]),
        "survivalRate": estimate([1.0 if entry["survived"] else 0.0 for entry in episodes]),
    }
    evidence = {
        "schemaVersion": 1,
        "kind": "microduck_seeded_whole_body_control_evaluation",
        "binding": item,
        "actionScale": config["actionScale"],
        "episodes": episodes,
        "metrics": metrics,
        "runtime": {
            "mujocoVersion": mujoco.__version__,
            "pythonVersion": sys.version.split()[0],
            "dependencies": runtime_dependencies,
        },
    }
    evidence_bytes = canonical_bytes(evidence)
    evidence_sha256 = sha256_bytes(evidence_bytes)
    capture_dir = Path(require_env("F311_CAPTURE_DIR")).resolve()
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / f"{item['subjectId']}-{item['split']}-{evidence_sha256}.json").write_bytes(evidence_bytes)
    return {
        **item,
        "status": "passed",
        "sampleCount": len(seeds),
        "captureRef": f"capture:sha256:{evidence_sha256}",
        "jobRef": None,
        "metrics": metrics,
        "refusal": None,
    }


def main() -> int:
    try:
        item = json.load(sys.stdin)
        print(json.dumps(run(item), sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:  # runner boundary emits no secret-bearing traceback
        detail_hash = sha256_bytes(str(error).encode())
        print(json.dumps({"status": "refused", "code": "control_runner_refused", "detailHash": detail_hash}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
