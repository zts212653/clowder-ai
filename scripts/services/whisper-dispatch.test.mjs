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
// Helper: extract the PRODUCTION dispatch logic from whisper-install.sh and
// evaluate it with a controlled WHISPER_MODEL. We use sed to extract lines
// from the model detection block up to the "source install-template" line,
// so we get the real SERVICE_LABEL / PIP_DEPS_* without triggering the
// install pipeline.
// ---------------------------------------------------------------------------
function getInstallDispatch(model) {
  const installPath = join(SERVICES_DIR, 'whisper-install.sh');
  // Extract lines 12-30 (variable declarations + model dispatch) from the
  // production script, stopping before the `source` and `install_service_main`
  // lines. This runs the REAL dispatch logic, not a hand-written copy.
  // Extract from MODEL_ENV_VAR= through PIP_DEPS_OTHER= / MODEL_LOADER_OTHER=
  // (stops before `source install-template.sh`). Pattern-anchored, not line-numbered.
  const script = [
    `export WHISPER_MODEL="${model}"`,
    `eval "$(sed -n '/^MODEL_ENV_VAR=/,/^MODEL_LOADER_OTHER=/p' '${installPath}')"`,
    'echo "label=$SERVICE_LABEL"',
    'echo "deps=$PIP_DEPS_ARM64"',
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

  test('setup.sh model selection uses canonical Python resolver (#1061)', () => {
    // setup.sh must use python-resolve.sh (the same resolver the installer
    // uses) to determine Python architecture, not a standalone python3 probe.
    // This ensures setup and installer agree on which Python determines MLX.
    const src = readFileSync(join(SERVICES_DIR, '../setup.sh'), 'utf8');
    // Must source the canonical resolver
    assert.match(src, /source.*python-resolve\.sh/, 'must source python-resolve.sh');
    // Must use resolver's probe functions (not raw python3 call)
    assert.match(src, /_try_system_pythons/, 'must use resolver system probe');
    // Must also probe project-local/legacy cache (not skip to bootstrap)
    assert.match(src, /_try_project_python/, 'must probe project-local Python cache');
    assert.match(src, /_try_legacy_project_python/, 'must probe legacy Python cache');
    // Must read RESOLVED_PYTHON_ARCH from resolver
    assert.match(src, /RESOLVED_PYTHON_ARCH/, 'must use RESOLVED_PYTHON_ARCH');
    // Qwen model must be guarded by _py_arch check
    assert.match(src, /_py_arch.*arm64.*Qwen3-ASR/s, 'Qwen model must be guarded by Python arch check');
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests: verify the install dispatch produces correct outputs.
// (Server dispatch is internal to whisper-api.py — tested via TypeScript unit
// tests in services-lifecycle-route.test.js.)
// ---------------------------------------------------------------------------
describe('whisper-dispatch — install backend selection', () => {
  // Production PIP_DEPS_ARM64 contains the full pip install list
  // (e.g. "mlx-audio fastapi uvicorn ..."). We verify the primary package
  // (first token) to test model→backend dispatch without coupling to the
  // exact set of shared deps that may change independently.
  const primaryDep = (deps) => deps?.split(' ')[0];

  test('Qwen3-ASR-1.7B-8bit -> mlx-audio + Qwen3 ASR label', () => {
    const r = getInstallDispatch('mlx-community/Qwen3-ASR-1.7B-8bit');
    assert.equal(primaryDep(r.deps), 'mlx-audio');
    assert.equal(r.label, 'Qwen3 ASR');
  });

  test('Qwen3-ASR-1.7B-4bit -> mlx-audio', () => {
    const r = getInstallDispatch('mlx-community/Qwen3-ASR-1.7B-4bit');
    assert.equal(primaryDep(r.deps), 'mlx-audio');
  });

  test('whisper-large-v3-turbo -> mlx-whisper + Whisper ASR label', () => {
    const r = getInstallDispatch('mlx-community/whisper-large-v3-turbo');
    assert.equal(primaryDep(r.deps), 'mlx-whisper');
    assert.equal(r.label, 'Whisper ASR');
  });

  test('whisper-small-mlx -> mlx-whisper', () => {
    const r = getInstallDispatch('mlx-community/whisper-small-mlx');
    assert.equal(primaryDep(r.deps), 'mlx-whisper');
  });

  test('empty model -> mlx-whisper (fallback)', () => {
    const r = getInstallDispatch('');
    assert.equal(primaryDep(r.deps), 'mlx-whisper');
  });
});

// ---------------------------------------------------------------------------
// Regression: setup.sh model selection must match installer (#863 #1061)
// Verifies that the model written to .env matches what the installer expects.
// The key invariant: setup selects Qwen IFF the installer will use MLX.
// ---------------------------------------------------------------------------

/**
 * Extract the PRODUCTION model selection block from setup.sh and evaluate
 * with mocked system commands and resolver functions. The production code
 * sources python-resolve.sh and calls the complete no-download probe chain
 * (system → uv → pyenv → brew → project-local → legacy) to find the same
 * Python the installer will use.
 *
 * @param hwArch       - simulated uname -m / sysctl result
 * @param opts.resolvedArch - arch the resolver would report
 * @param opts.source  - which probe tier finds it ('system'|'project'|'legacy'|'none')
 */
function getSetupModelSelection(hwArch, resolvedArch, source = 'system') {
  const setupPath = join(SERVICES_DIR, '../setup.sh');
  const sysctlStub = hwArch === 'arm64' ? 'echo 1' : 'return 1';
  const resolverOk = `RESOLVED_PYTHON_ARCH="${resolvedArch}"; return 0`;
  const resolverFail = 'return 1';
  // Each probe tier succeeds only if source matches that tier.
  const sysStub = source === 'system' ? resolverOk : resolverFail;
  const projStub = source === 'project' ? resolverOk : resolverFail;
  const legacyStub = source === 'legacy' ? resolverOk : resolverFail;
  const sedExpr = '/^# .* Resolve ASR default model/,/^# .* Step 4: Generate/{' + '/^# .* Step 4: Generate/d; p;}';
  const script = [
    'ENABLE_ASR=true',
    `uname() { case "$1" in -s) echo "Darwin";; -m) echo "${hwArch}";; esac; }`,
    `sysctl() { ${sysctlStub}; }`,
    'source() { :; }',
    `_try_system_pythons() { ${sysStub}; }`,
    `_try_uv() { ${resolverFail}; }`,
    `_try_pyenv() { ${resolverFail}; }`,
    `_try_brew() { ${resolverFail}; }`,
    `_try_project_python() { ${projStub}; }`,
    `_try_legacy_project_python() { ${legacyStub}; }`,
    `eval "$(sed -n '${sedExpr}' '${setupPath}')"`,
    'echo "$ASR_DEFAULT_MODEL"',
  ].join('\n');
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

describe('setup.sh — model selection consistency (#863 #1061)', () => {
  test('Apple Silicon + system arm64 Python -> Qwen3-ASR (MLX)', () => {
    assert.equal(getSetupModelSelection('arm64', 'arm64', 'system'), 'mlx-community/Qwen3-ASR-1.7B-8bit');
  });

  test('Apple Silicon + system x86_64 Python (Rosetta) -> large-v3-turbo', () => {
    assert.equal(getSetupModelSelection('arm64', 'x86_64', 'system'), 'large-v3-turbo');
  });

  test('Apple Silicon + cached project x86_64 Python -> large-v3-turbo', () => {
    // Regression: old Rosetta install cached x86_64 project Python.
    // Setup must detect this via _try_project_python, not skip to bootstrap.
    assert.equal(getSetupModelSelection('arm64', 'x86_64', 'project'), 'large-v3-turbo');
  });

  test('Apple Silicon + cached project arm64 Python -> Qwen3-ASR', () => {
    assert.equal(getSetupModelSelection('arm64', 'arm64', 'project'), 'mlx-community/Qwen3-ASR-1.7B-8bit');
  });

  test('Apple Silicon + legacy cached x86_64 Python -> large-v3-turbo', () => {
    // Legacy cache from pre-move path — installer will reuse, not bootstrap.
    assert.equal(getSetupModelSelection('arm64', 'x86_64', 'legacy'), 'large-v3-turbo');
  });

  test('Apple Silicon + no Python 3.12+ anywhere -> Qwen (bootstrap arm64)', () => {
    // All probes fail → installer downloads via _pbs_target_triple (sysctl).
    assert.equal(getSetupModelSelection('arm64', 'irrelevant', 'none'), 'mlx-community/Qwen3-ASR-1.7B-8bit');
  });

  test('Intel Mac -> large-v3-turbo', () => {
    assert.equal(getSetupModelSelection('x86_64', 'x86_64', 'system'), 'large-v3-turbo');
  });

  test('setup model agrees with installer platform detection', () => {
    // Invariant: when setup selects Qwen, installer must use MLX (is_darwin_arm64=1).
    // When setup selects large-v3-turbo, installer must use non-MLX.
    // This cross-validates the two detection paths share the same truth source.
    const cases = [
      { hw: 'arm64', pyArch: 'arm64', expectMLX: true },
      { hw: 'arm64', pyArch: 'x86_64', expectMLX: false },
      { hw: 'x86_64', pyArch: 'x86_64', expectMLX: false },
    ];
    for (const c of cases) {
      const model = getSetupModelSelection(c.hw, c.pyArch);
      const isMLX = getPlatformDetection('Darwin', c.hw, c.pyArch);
      const setupWantsMLX = model.includes('Qwen3-ASR');
      const installerUsesMLX = isMLX === '1';
      assert.equal(
        setupWantsMLX,
        installerUsesMLX,
        `hw=${c.hw} py=${c.pyArch}: setup=${model} but installer is_darwin_arm64=${isMLX}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: install-template.sh platform detection (#1061)
// Verifies that the MLX branch requires BOTH arm64 hardware AND arm64 Python.
// ---------------------------------------------------------------------------

/**
 * Run the PRODUCTION platform detection from install-template.sh by
 * extracting the detection block with sed and executing it with mocked
 * system commands. Tests the real script content, not a hand-written copy.
 */
function getPlatformDetection(platform, hwArch, pythonArch) {
  const templatePath = join(SERVICES_DIR, 'install-template.sh');
  // Override uname/sysctl so the extracted production code sees controlled
  // values. sysctl returns '1' iff hwArch=arm64 (simulates Apple Silicon).
  const sysctlStub = hwArch === 'arm64' ? 'echo 1' : 'return 1';
  // Extract the detection block from production install-template.sh with sed:
  //   - Range: from `local platform hw_arch` to `# 4.` (next section header)
  //   - Delete the section header line and pure declarations (no `=`)
  //   - Strip `local ` prefix from assignment lines (local is function-scoped)
  // Single-line sed avoids BSD sed treating multi-arg strings as filenames.
  const sedExpr =
    '/^  local platform hw_arch python_arch/,/^  # 4\\./{' + '/^  # 4\\./d; /^  local [^=]*$/d; s/^  local //; p;}';
  const script = [
    `uname() { case "$1" in -s) echo "${platform}";; -m) echo "${hwArch}";; esac; }`,
    `sysctl() { ${sysctlStub}; }`,
    `export RESOLVED_PYTHON_ARCH="${pythonArch}"`,
    `eval "$(sed -n '${sedExpr}' '${templatePath}')"`,
    'echo "$is_darwin_arm64"',
  ].join('\n');
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
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

// ---------------------------------------------------------------------------
// Regression: python-resolve.sh bootstrap target triple (#1061)
// Sources the PRODUCTION _pbs_target_triple() with mocked system commands.
// ---------------------------------------------------------------------------

/**
 * Source python-resolve.sh and call _pbs_target_triple() with mocked
 * uname/sysctl. Tests the real function, not a hand-written copy.
 */
function getBootstrapTriple(os, unameM, sysctlArm64) {
  const resolvePath = join(SERVICES_DIR, 'python-resolve.sh');
  const sysctlBody = sysctlArm64 === '1' ? 'echo 1' : sysctlArm64 === 'fail' ? 'return 1' : 'echo 0';
  const script = [
    // Mock system commands before sourcing
    `uname() { case "$1" in -s) echo "${os}";; -m) echo "${unameM}";; esac; }`,
    `sysctl() { ${sysctlBody}; }`,
    'export -f uname sysctl',
    // Source production code (only defines functions, no side effects)
    `source "${resolvePath}"`,
    // Call the real function
    '_pbs_target_triple',
  ].join('\n');
  try {
    return execFileSync('bash', ['-c', script], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'unsupported';
  }
}

describe('python-resolve — bootstrap target triple regression (#1061)', () => {
  test('Darwin + sysctl arm64=1 -> aarch64-apple-darwin (normal Apple Silicon)', () => {
    assert.equal(getBootstrapTriple('Darwin', 'arm64', '1'), 'aarch64-apple-darwin');
  });

  test('Darwin + Rosetta (uname x86_64) + sysctl arm64=1 -> aarch64-apple-darwin', () => {
    // Key Rosetta regression: uname -m says x86_64 but sysctl detects arm64 hardware.
    // Bootstrap must install arm64 Python, not x86_64.
    assert.equal(getBootstrapTriple('Darwin', 'x86_64', '1'), 'aarch64-apple-darwin');
  });

  test('Darwin + native arm64 + sysctl failure -> aarch64-apple-darwin (fallback)', () => {
    // sysctl fails but uname -m=arm64 is a reliable one-direction signal.
    assert.equal(getBootstrapTriple('Darwin', 'arm64', 'fail'), 'aarch64-apple-darwin');
  });

  test('Darwin + Intel (uname x86_64) + sysctl absent -> x86_64-apple-darwin', () => {
    assert.equal(getBootstrapTriple('Darwin', 'x86_64', '0'), 'x86_64-apple-darwin');
  });

  test('Linux + x86_64 -> x86_64-unknown-linux-gnu', () => {
    assert.equal(getBootstrapTriple('Linux', 'x86_64', 'fail'), 'x86_64-unknown-linux-gnu');
  });

  test('Linux + aarch64 -> aarch64-unknown-linux-gnu', () => {
    assert.equal(getBootstrapTriple('Linux', 'aarch64', 'fail'), 'aarch64-unknown-linux-gnu');
  });
});
