"""Pinned embedding recipe verification. No model import or inference here."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

DEPLOYMENT_PATH = Path(__file__).resolve().parents[2] / "packages/api/runtime/services/embedding-generations.json"


def read_deployment(path: Path = DEPLOYMENT_PATH) -> dict:
    value = json.loads(path.read_text())
    if value.get("version") != 1:
        raise ValueError("Unsupported embedding deployment")
    ids = [value["activeId"], value["buildTargetId"], *value["retainedIds"]]
    if any(item not in {"g0", "g1"} for item in ids):
        raise ValueError("Invalid embedding generation")
    return value


def recipe_fingerprint(recipe: dict) -> str:
    return hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_model_artifacts(recipe: dict, snapshot: Path, backend_root: Path) -> str:
    """Verify the actual bytes loaded, not only a repo name or directory label."""
    expected = {
        "config.json": recipe["modelConfigSha256"],
        "tokenizer.json": recipe["tokenizerSha256"],
        "tokenizer_config.json": recipe["tokenizerConfigSha256"],
    }
    weights = sorted(snapshot.glob("model*.safetensors"))
    if ":".join(file_hash(path) for path in weights) != recipe["weightsSha256"]:
        raise ValueError("Embedding weight identity mismatch")
    for name, digest in expected.items():
        if file_hash(snapshot / name) != digest:
            raise ValueError("Embedding artifact identity mismatch")
    config = json.loads((snapshot / "config.json").read_text())
    if config.get("quantization") or config.get("torch_dtype") != "bfloat16":
        raise ValueError("Embedding weight dtype mismatch")
    for package, version in [("mlx-embeddings", recipe["backendVersion"]), ("mlx", recipe["mlxVersion"])]:
        if importlib.metadata.version(package) != version:
            raise ValueError("Embedding backend version mismatch")
    entries = [[str(path.relative_to(backend_root)), file_hash(path)] for path in sorted(backend_root.rglob("*.py"))]
    digest = hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()
    if digest != recipe["backendCodeSha256"]:
        raise ValueError("Embedding backend code identity mismatch")
    return recipe_fingerprint(recipe)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generation", choices=["g0", "g1"])
    parser.add_argument("--field", choices=["generation", "model"], required=True)
    args = parser.parse_args()
    deployment = read_deployment()
    generation = args.generation or deployment["activeId"]
    recipe = deployment["generations"][generation]["recipe"]
    print(generation if args.field == "generation" else (recipe["modelId"] if recipe else ""))


if __name__ == "__main__":
    main()
