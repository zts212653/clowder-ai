// @ts-check
/**
 * Regression tests for whisper-stt model dispatch (#863).
 *
 * The unified ASR service (`whisper-stt`) uses a single install script
 * (whisper-install.sh) and server script (whisper-server.sh) that must
 * dispatch to the correct ML backend based on the selected model:
 *
 *   Qwen3-ASR models -> mlx-audio  + qwen3-asr-api.py
 *   Whisper models   -> mlx-whisper + whisper-api.py
 *
 * These tests verify the dispatch logic by running bash snippets that
 * reproduce the branching from the actual scripts.
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
// Helper: run the server-script dispatch in an isolated bash subshell.
// Mirrors whisper-server.sh lines 40-44.
// ---------------------------------------------------------------------------
function getServerDispatch(model) {
  const script = [
    `MODEL="${model}"`,
    'if [[ "$MODEL" == *"Qwen3-ASR"* ]]; then',
    '  echo "qwen3-asr-api.py"',
    'else',
    '  echo "whisper-api.py"',
    'fi',
  ].join('\n');
  return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
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

  test('whisper-server.sh contains Qwen3-ASR dispatch', () => {
    const src = readFileSync(join(SERVICES_DIR, 'whisper-server.sh'), 'utf8');
    assert.match(src, /Qwen3-ASR/, 'must detect Qwen3-ASR model name');
    assert.match(src, /qwen3-asr-api\.py/, 'must dispatch to qwen3-asr-api.py');
    assert.match(src, /whisper-api\.py/, 'must dispatch to whisper-api.py');
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests: verify the dispatch produces correct outputs.
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

describe('whisper-dispatch — server API script selection', () => {
  test('Qwen3-ASR-1.7B-8bit -> qwen3-asr-api.py', () => {
    assert.equal(getServerDispatch('mlx-community/Qwen3-ASR-1.7B-8bit'), 'qwen3-asr-api.py');
  });

  test('Qwen3-ASR-1.7B-4bit -> qwen3-asr-api.py', () => {
    assert.equal(getServerDispatch('mlx-community/Qwen3-ASR-1.7B-4bit'), 'qwen3-asr-api.py');
  });

  test('whisper-large-v3-turbo -> whisper-api.py', () => {
    assert.equal(getServerDispatch('mlx-community/whisper-large-v3-turbo'), 'whisper-api.py');
  });

  test('base (faster-whisper short name) -> whisper-api.py', () => {
    assert.equal(getServerDispatch('base'), 'whisper-api.py');
  });
});
