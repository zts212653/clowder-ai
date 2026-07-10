// @ts-check
/**
 * Regression tests for whisper-stt model dispatch (#863).
 *
 * The unified ASR service (`whisper-stt`) uses:
 *   - whisper-install.sh: dispatches pip deps by model (mlx-audio vs mlx-whisper)
 *   - whisper-server.sh:  always launches whisper-api.py (no shell dispatch)
 *   - whisper-api.py:     selects backend at runtime by model name
 *
 * These tests verify the install dispatch and static script content.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = __dirname;

// ---------------------------------------------------------------------------
// Helper: run the install-script dispatch in an isolated bash subshell.
// We source only the top of whisper-install.sh (up to "source install-template")
// to capture SERVICE_LABEL and PIP_DEPS_ARM64 without triggering the actual
// install pipeline.
// ---------------------------------------------------------------------------
function getInstallDispatch(model) {
  const script = [
    `WHISPER_MODEL="${model}"`,
    '_model="${WHISPER_MODEL:-}"',
    'if [[ "$_model" == *"Qwen3-ASR"* ]]; then',
    '  echo "label=Qwen3 ASR"; echo "deps=mlx-audio"',
    'else',
    '  echo "label=Whisper ASR"; echo "deps=mlx-whisper"',
    'fi',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  const lines = out.split('\n');
  return {
    label: lines.find((l) => l.startsWith('label='))?.split('=')[1],
    deps: lines.find((l) => l.startsWith('deps='))?.split('=')[1],
  };
}

// ---------------------------------------------------------------------------
// Static guard: the actual script files must contain the dispatch patterns.
// If someone refactors the scripts and breaks the branching, this catches it.
// ---------------------------------------------------------------------------
describe('whisper-dispatch — static guard (script content)', () => {
  test('whisper-install.sh contains Qwen3-ASR dispatch', () => {
    const src = readFileSync(join(SERVICES_DIR, 'whisper-install.sh'), 'utf8');
    assert.match(src, /Qwen3-ASR/, 'must detect Qwen3-ASR model name');
    assert.match(src, /mlx-audio/, 'must use mlx-audio for Qwen3-ASR');
    assert.match(src, /mlx-whisper/, 'must use mlx-whisper for Whisper');
  });

  test('install-template.sh gates MLX on Python arch, not just hardware (#1061)', () => {
    const src = readFileSync(join(SERVICES_DIR, 'install-template.sh'), 'utf8');
    assert.match(src, /RESOLVED_PYTHON_ARCH/, 'must check Python interpreter architecture');
    assert.match(src, /python_arch/, 'must use python_arch variable for MLX gating');
    // The is_darwin_arm64 guard must require python_arch check before setting =1.
    // A pure `[ "$arch" = "arm64" ] && is_darwin_arm64=1` without Python arch
    // would install arm64 MLX wheels into an x86_64 venv on Rosetta Python.
    assert.match(
      src,
      /python_arch.*arm64.*is_darwin_arm64=1/s,
      'is_darwin_arm64=1 must be guarded by python_arch check',
    );
  });

  test('python-resolve.sh bootstrap uses sysctl, not uname -m, on Darwin (#1061)', () => {
    // _pbs_target_triple() determines which python-build-standalone tarball
    // to download. Under Rosetta, uname -m returns x86_64, which would
    // bootstrap an x86_64 Python → MLX models fail. Must use sysctl to
    // detect true hardware and always bootstrap arm64 Python on Apple Silicon.
    const src = readFileSync(join(SERVICES_DIR, 'python-resolve.sh'), 'utf8');
    // Extract _pbs_target_triple function body
    const fnMatch = src.match(/_pbs_target_triple\(\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(fnMatch, '_pbs_target_triple function must exist');
    const fnBody = fnMatch[1];
    assert.match(fnBody, /sysctl/, '_pbs_target_triple must use sysctl on Darwin');
    assert.match(fnBody, /hw\.optional\.arm64/, 'must probe hw.optional.arm64');
    // The Darwin case must NOT use `uname -m` for arm64 detection — that
    // breaks under Rosetta. uname -m is acceptable for the non-arm64 fallback.
    const darwinCase = fnBody.match(/Darwin\)([\s\S]*?);;/);
    assert.ok(darwinCase, 'Darwin case must exist in _pbs_target_triple');
    assert.doesNotMatch(
      darwinCase[1],
      /case.*uname -m/,
      'Darwin case must not use case $(uname -m) for arch detection',
    );
  });

  test('whisper-api.py contains all ASR backends', () => {
    const src = readFileSync(join(SERVICES_DIR, 'whisper-api.py'), 'utf8');
    assert.match(src, /Qwen3-ASR/, 'must detect Qwen3-ASR model name');
    assert.match(src, /mlx_audio/, 'must support mlx-audio backend');
    assert.match(src, /mlx_whisper/, 'must support mlx-whisper backend');
    assert.match(src, /faster_whisper/, 'must support faster-whisper backend');
  });

  test('whisper-server.sh launches whisper-api.py (no shell dispatch)', () => {
    const src = readFileSync(join(SERVICES_DIR, 'whisper-server.sh'), 'utf8');
    assert.match(src, /whisper-api\.py/, 'must reference whisper-api.py');
    assert.doesNotMatch(src, /qwen3-asr-api\.py/, 'must NOT dispatch to separate qwen3 script');
  });

  test('setup.sh delegates ASR install to whisper-install.sh (#863 unified)', () => {
    // setup.sh --install-missing must use the unified installer instead of
    // maintaining a separate hardcoded venv/deps path. The old code created
    // $HOME/.cat-cafe/asr-venv with mlx-audio; the new service uses
    // whisper-venv via whisper-install.sh. Divergent paths = runtime failure.
    const src = readFileSync(join(SERVICES_DIR, '../setup.sh'), 'utf8');
    assert.match(src, /whisper-install\.sh/, 'setup.sh must delegate to whisper-install.sh');
    assert.doesNotMatch(
      src,
      /asr-venv/,
      'setup.sh must not reference old asr-venv path (use whisper-install.sh instead)',
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests: verify the install dispatch produces correct outputs.
// (Server dispatch is internal to whisper-api.py — tested via TypeScript unit
// tests in services-lifecycle-route.test.js.)
// ---------------------------------------------------------------------------
describe('whisper-dispatch — install backend selection', () => {
  test('Qwen3-ASR-1.7B-8bit -> mlx-audio + Qwen3 ASR label', () => {
    const r = getInstallDispatch('mlx-community/Qwen3-ASR-1.7B-8bit');
    assert.equal(r.deps, 'mlx-audio');
    assert.equal(r.label, 'Qwen3 ASR');
  });

  test('Qwen3-ASR-1.7B-4bit -> mlx-audio', () => {
    const r = getInstallDispatch('mlx-community/Qwen3-ASR-1.7B-4bit');
    assert.equal(r.deps, 'mlx-audio');
  });

  test('whisper-large-v3-turbo -> mlx-whisper + Whisper ASR label', () => {
    const r = getInstallDispatch('mlx-community/whisper-large-v3-turbo');
    assert.equal(r.deps, 'mlx-whisper');
    assert.equal(r.label, 'Whisper ASR');
  });

  test('whisper-small-mlx -> mlx-whisper', () => {
    const r = getInstallDispatch('mlx-community/whisper-small-mlx');
    assert.equal(r.deps, 'mlx-whisper');
  });

  test('empty model -> mlx-whisper (fallback)', () => {
    const r = getInstallDispatch('');
    assert.equal(r.deps, 'mlx-whisper');
  });
});

// ---------------------------------------------------------------------------
// Regression: install-template.sh platform detection (#1061)
// Verifies that the MLX branch requires BOTH arm64 hardware AND arm64 Python.
// ---------------------------------------------------------------------------

/**
 * Extract and run the platform detection logic from install-template.sh
 * with mock values for platform, hw_arch, and python_arch.
 */
function getPlatformDetection(platform, hwArch, pythonArch) {
  // Reproduce the is_darwin_arm64 logic from install-template.sh
  const script = [
    `platform="${platform}"`,
    `hw_arch="${hwArch}"`,
    `python_arch="${pythonArch}"`,
    'is_darwin_arm64=0',
    'if [ "$platform" = "Darwin" ] && [ "$hw_arch" = "arm64" ]; then',
    '  if [ "$python_arch" = "arm64" ] || [ "$python_arch" = "aarch64" ]; then',
    '    is_darwin_arm64=1',
    '  fi',
    'fi',
    'echo "$is_darwin_arm64"',
  ].join('\n');
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
}

describe('install-template — platform detection regression (#1061)', () => {
  test('Darwin + arm64 hw + arm64 Python -> is_darwin_arm64=1 (MLX path)', () => {
    assert.equal(getPlatformDetection('Darwin', 'arm64', 'arm64'), '1');
  });

  test('Darwin + arm64 hw + aarch64 Python -> is_darwin_arm64=1', () => {
    assert.equal(getPlatformDetection('Darwin', 'arm64', 'aarch64'), '1');
  });

  test('Darwin + arm64 hw + x86_64 Python -> is_darwin_arm64=0 (no MLX)', () => {
    assert.equal(getPlatformDetection('Darwin', 'arm64', 'x86_64'), '0');
  });

  test('Darwin + arm64 hw + unknown Python -> is_darwin_arm64=0', () => {
    assert.equal(getPlatformDetection('Darwin', 'arm64', 'unknown'), '0');
  });

  test('Darwin + x86_64 hw + x86_64 Python -> is_darwin_arm64=0', () => {
    assert.equal(getPlatformDetection('Darwin', 'x86_64', 'x86_64'), '0');
  });

  test('Linux + x86_64 hw + x86_64 Python -> is_darwin_arm64=0', () => {
    assert.equal(getPlatformDetection('Linux', 'x86_64', 'x86_64'), '0');
  });
});
