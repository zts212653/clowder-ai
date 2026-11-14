"""First-party pinned-generation installation. Shares runtime's recipe and byte verifier; no inference."""
from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

from embedding_generation import read_deployment, verify_model_artifacts


def install_recipe(generation: str | None = None) -> dict | None:
    deployment = read_deployment()
    generation = generation or deployment['activeId']
    if generation not in {'g0', 'g1'}:
        raise ValueError('Invalid embedding generation')
    recipe = deployment['generations'][generation]['recipe']
    if recipe and (recipe['backend'] != 'mlx-embeddings' or platform.system() != 'Darwin' or platform.machine().lower() not in {'arm64', 'aarch64'}):
        raise ValueError('Pinned embedding generation unsupported: requires native Darwin arm64 MLX')
    return recipe


def install_pinned(recipe: dict, generation: str) -> None:
    # Pin both packages even when a compatible-looking venv already exists.
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--progress-bar', 'on',
                    f"mlx=={recipe['mlxVersion']}", f"mlx-embeddings=={recipe['backendVersion']}",
                    'fastapi', 'uvicorn', 'numpy', 'httpx[socks]', 'transformers<5', 'huggingface-hub[hf_xet]<1.0'], check=True)
    # Match canonical per-download injection. Pip above never inherits the HF-only proxy.
    download_env = os.environ.copy()
    proxy = download_env.get('_CATCAFE_HF_PROXY_FOR_DOWNLOAD')
    if proxy:
        download_env.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy)
    subprocess.run([sys.executable, str(Path(__file__).resolve()), '--generation', generation,
                    '--download-and-verify'], env=download_env, check=True)


def download_and_verify(recipe: dict) -> str:
    # Set before importing huggingface_hub: it captures this timeout during import.
    os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
    import huggingface_hub
    from huggingface_hub import snapshot_download
    # Preserve useful network diagnostics without printing proxy credentials or endpoints.
    print(f'[hf-download diag] huggingface_hub={huggingface_hub.__version__}; pinned revision={recipe["modelRevision"]}', file=sys.stderr)
    for key in ('HF_ENDPOINT', 'HF_HUB_ENDPOINT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'):
        print(f'[hf-download diag] {key}={"configured" if os.environ.get(key) else "unset"}', file=sys.stderr)
    print(f'[hf-download diag] HF_HUB_DOWNLOAD_TIMEOUT={os.environ["HF_HUB_DOWNLOAD_TIMEOUT"]}', file=sys.stderr)
    for attempt in range(1, 4):
        try:
            snapshot = Path(snapshot_download(repo_id=recipe['modelId'], revision=recipe['modelRevision']))
            break
        except Exception as exc:
            print(f'Download attempt {attempt}/3 failed: {type(exc).__name__}', file=sys.stderr)
            if attempt == 3:
                raise RuntimeError('Model download failed after 3 attempts') from None
            wait = 5 * attempt
            print(f'Retrying in {wait}s...', file=sys.stderr)
            time.sleep(wait)
    spec = importlib.util.find_spec('mlx_embeddings')
    if not spec or not spec.origin:
        raise ValueError('Pinned embedding backend missing after installation')
    # Runtime uses this exact verifier before load(local_files_only=True).
    return verify_model_artifacts(recipe, snapshot, Path(spec.origin).parent)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--generation', choices=['g0', 'g1'])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check-platform', action='store_true')
    mode.add_argument('--execute', action='store_true')
    mode.add_argument('--download-and-verify', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    generation = args.generation or read_deployment()['activeId']
    recipe = install_recipe(generation)
    if args.execute or args.download_and_verify:
        if not recipe:
            raise ValueError('Legacy generation uses the existing compatible installer')
        if args.execute:
            install_pinned(recipe, generation)
        else:
            print(f'verified representation {download_and_verify(recipe)}')


if __name__ == '__main__':
    main()
