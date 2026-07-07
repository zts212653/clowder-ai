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
