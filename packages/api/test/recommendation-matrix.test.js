// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildRecommendation, findMatrixEntry, getMatrixServiceIds } = await import(
  '../dist/domains/services/recommendation-matrix.js'
);

function makeProfile(overrides = {}) {
  return {
    os: 'darwin',
    arch: 'arm64',
    gpu: 'apple',
    pythonArch: 'native',
    pythonVersion: '3.11.0',
    ramGb: 32,
    diskFreeGb: 200,
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe('recommendation matrix — service coverage', () => {
  test('matrix covers all 5 core services (qwen3-asr merged into whisper-stt)', () => {
    const ids = getMatrixServiceIds();
    assert.deepEqual(
      ids.sort(),
      ['whisper-stt', 'mlx-tts', 'embedding-model', 'llm-postprocess', 'audio-capture'].sort(),
    );
  });

  // codex P1 2026-05-26: audio-capture exposes install/start scripts but
  // the F195 runtime (scripts/meeting-copilot/audio-service.py) is not in
  // this repo, so install would fail 100% on every platform. Marking the
  // service unsupported in the matrix is what gates the modal install
  // button — this test locks that contract so a future matrix tweak that
  // accidentally re-enables audio-capture without bundling the runtime
  // will be caught at CI.
  test('audio-capture is unsupported on every platform until F195 runtime is bundled', () => {
    const platforms = [
      makeProfile({ os: 'darwin', arch: 'arm64', gpu: 'apple' }),
      makeProfile({ os: 'darwin', arch: 'x64', gpu: 'none' }),
      makeProfile({ os: 'linux', arch: 'x64', gpu: 'cuda' }),
      makeProfile({ os: 'linux', arch: 'x64', gpu: 'none' }),
      makeProfile({ os: 'win32', arch: 'arm64', pythonArch: 'native', gpu: 'none' }),
      makeProfile({ os: 'win32', arch: 'x64', gpu: 'none' }),
    ];
    for (const profile of platforms) {
      const rec = buildRecommendation('audio-capture', profile);
      assert.ok(rec.unsupported, `audio-capture should be unsupported on ${profile.os}/${profile.arch}`);
      assert.match(rec.unsupported.reason, /F195|audio-service\.py|runtime/i);
    }
  });
});

describe('recommendation matrix — macOS arm64', () => {
  const profile = makeProfile();

  test('whisper-stt → Qwen3-ASR 8bit as default on macOS arm64 (#863)', () => {
    const rec = buildRecommendation('whisper-stt', profile);
    assert.equal(rec.models[0]?.name, 'mlx-community/Qwen3-ASR-1.7B-8bit');
    assert.equal(rec.unsupported, undefined);
    // Both Qwen3-ASR and Whisper models should be available
    assert.ok(rec.models.length >= 4);
    assert.ok(rec.models.some((m) => m.name.includes('whisper')));
  });

  test('embedding-model → Qwen3 MLX as default', () => {
    const rec = buildRecommendation('embedding-model', profile);
    assert.match(rec.models[0]?.name ?? '', /Qwen3-Embedding/);
  });

  test('llm-postprocess → Qwen3.5-35B with multiple models + notes', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.match(rec.models[0]?.name ?? '', /Qwen3\.5-35B/);
    assert.ok(rec.models.length >= 3);
    assert.ok(rec.notes.some((c) => c.includes('48GB')));
  });

  test('mlx-tts → Kokoro as default', () => {
    const rec = buildRecommendation('mlx-tts', profile);
    assert.match(rec.models[0]?.name ?? '', /Kokoro/);
  });

  test('whisper-stt + x86-emulated Python → faster-whisper, not MLX (#1061)', () => {
    const rosettaProfile = makeProfile({ pythonArch: 'x86-emulated' });
    const rec = buildRecommendation('whisper-stt', rosettaProfile);
    assert.equal(rec.unsupported, undefined, 'should not be unsupported, just non-MLX');
    assert.ok(rec.models.length >= 2, 'should have faster-whisper models');
    // Must NOT recommend MLX models on x86-emulated Python
    assert.ok(
      !rec.models.some((m) => m.name.includes('mlx-community')),
      'must not recommend mlx-community models when Python is x86-emulated',
    );
    assert.equal(rec.models[0]?.name, 'large-v3-turbo', 'should default to faster-whisper turbo');
  });

  test('whisper-stt + missing Python on arm64 → MLX models (bootstrap installs arm64 Python)', () => {
    const missingProfile = makeProfile({ pythonArch: 'missing' });
    const rec = buildRecommendation('whisper-stt', missingProfile);
    assert.equal(rec.unsupported, undefined);
    // On native Apple Silicon, python-build-standalone bootstraps arm64 Python,
    // so the installer takes the MLX path. Must recommend MLX models, not
    // faster-whisper short names which would fail with snapshot_download.
    assert.ok(
      rec.models.some((m) => m.name.includes('mlx-community')),
      'missing Python on arm64 must get MLX models (bootstrap provides arm64 Python)',
    );
  });

  // #1061 regression guard: resolveArch() now reports arm64 under Rosetta,
  // so ALL darwin/arm64 services must gate MLX on pythonArch, not just whisper-stt.
  test('mlx-tts + x86-emulated Python → edge-tts, not MLX (#1061)', () => {
    const rosettaProfile = makeProfile({ pythonArch: 'x86-emulated' });
    const rec = buildRecommendation('mlx-tts', rosettaProfile);
    assert.equal(rec.unsupported, undefined, 'should not be unsupported, just non-MLX');
    assert.ok(
      !rec.models.some((m) => m.name.includes('mlx-community')),
      'must not recommend mlx-community models when Python is x86-emulated',
    );
    assert.equal(rec.models[0]?.name, 'edge-tts');
    assert.ok(rec.customModelHint, 'Rosetta fallback must have customModelHint');
    assert.match(rec.customModelHint.unsupported, /MLX/i, 'hint must warn about MLX incompatibility');
    // Hint examples must be dispatch-valid install tokens, not synthesis-time voice names.
    // tts-server.sh only recognizes 'edge-tts', 'piper', 'zh_CN-*' etc. as install tokens.
    assert.ok(
      !rec.customModelHint.example.includes('Neural'),
      'hint must not show edge-tts voice names (zh-CN-*Neural) as install-model examples',
    );
  });

  test('embedding-model + x86-emulated Python → sentence-transformers, not MLX (#1061)', () => {
    const rosettaProfile = makeProfile({ pythonArch: 'x86-emulated' });
    const rec = buildRecommendation('embedding-model', rosettaProfile);
    assert.equal(rec.unsupported, undefined, 'should not be unsupported, just non-MLX');
    assert.ok(
      !rec.models.some((m) => m.name.includes('mlx-community')),
      'must not recommend mlx-community models when Python is x86-emulated',
    );
    assert.equal(rec.models[0]?.name, 'jinaai/jina-embeddings-v2-base-zh');
    assert.ok(rec.customModelHint, 'Rosetta fallback must have customModelHint');
    assert.match(rec.customModelHint.unsupported, /MLX/i, 'hint must warn about MLX incompatibility');
  });

  test('llm-postprocess + x86-emulated Python → transformers, not MLX (#1061)', () => {
    const rosettaProfile = makeProfile({ pythonArch: 'x86-emulated' });
    const rec = buildRecommendation('llm-postprocess', rosettaProfile);
    assert.equal(rec.unsupported, undefined, 'should not be unsupported, just non-MLX');
    assert.ok(
      !rec.models.some((m) => m.name.includes('mlx-community')),
      'must not recommend mlx-community models when Python is x86-emulated',
    );
    assert.equal(rec.models[0]?.name, 'Qwen/Qwen2.5-3B-Instruct');
    assert.ok(rec.customModelHint, 'Rosetta fallback must have customModelHint');
    assert.match(rec.customModelHint.unsupported, /MLX/i, 'hint must warn about MLX incompatibility');
  });

  test('missing Python on arm64 → MLX path for all services (bootstrap)', () => {
    const missingProfile = makeProfile({ pythonArch: 'missing' });
    for (const svc of ['mlx-tts', 'embedding-model', 'llm-postprocess']) {
      const rec = buildRecommendation(svc, missingProfile);
      assert.equal(rec.unsupported, undefined, `${svc} should not be unsupported`);
      assert.ok(
        rec.models.some((m) => m.name.includes('mlx-community')),
        `${svc}: missing Python on arm64 must get MLX models (bootstrap provides arm64 Python)`,
      );
    }
  });
});

describe('recommendation matrix — Windows ARM64', () => {
  const profile = makeProfile({ os: 'win32', arch: 'arm64', gpu: 'none' });

  test('llm-postprocess native python → unsupported with guidance', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.equal(rec.models.length, 0);
    assert.ok(rec.unsupported);
    assert.match(rec.unsupported.userAction, /x86 Python/);
    assert.match(rec.unsupported.retryHint, /关闭|重新/);
  });

  test('llm-postprocess x86-emulated python → Qwen2.5-3B', () => {
    const x86Profile = makeProfile({
      os: 'win32',
      arch: 'arm64',
      gpu: 'none',
      pythonArch: 'x86-emulated',
    });
    const rec = buildRecommendation('llm-postprocess', x86Profile);
    assert.equal(rec.models[0]?.name, 'Qwen/Qwen2.5-3B-Instruct');
    assert.equal(rec.unsupported, undefined);
    assert.ok(rec.notes.some((c) => c.includes('x86')));
  });

  test('embedding-model → unsupported (sqlite-vec has no windows-arm64 binary)', () => {
    const rec = buildRecommendation('embedding-model', profile);
    assert.equal(rec.models.length, 0);
    assert.ok(rec.unsupported);
    assert.match(rec.unsupported.reason, /sqlite-vec/);
    assert.match(rec.unsupported.userAction, /BM25|关键字|x64/);
  });

  test('whisper-stt native python → unsupported (PyAV/ctranslate2 no win-arm64 wheel)', () => {
    const rec = buildRecommendation('whisper-stt', profile);
    assert.equal(rec.models.length, 0);
    assert.ok(rec.unsupported);
    assert.match(rec.unsupported.reason, /PyAV|ctranslate2/);
    assert.match(rec.unsupported.userAction, /x86 Python/);
  });

  test('whisper-stt x86-emulated python → faster-whisper base', () => {
    const x86Profile = makeProfile({ os: 'win32', arch: 'arm64', gpu: 'none', pythonArch: 'x86-emulated' });
    const rec = buildRecommendation('whisper-stt', x86Profile);
    assert.equal(rec.models[0]?.name, 'base');
    assert.equal(rec.unsupported, undefined);
    assert.ok(rec.notes.some((n) => n.includes('x86')));
  });

  test('mlx-tts native python → SAPI-only (no aiohttp / piper deps needed)', () => {
    const rec = buildRecommendation('mlx-tts', profile);
    assert.equal(rec.unsupported, undefined);
    assert.equal(rec.models[0]?.name, 'sapi');
    assert.equal(rec.models.length, 1);
    assert.ok(rec.notes.some((n) => /ARM64|x86/.test(n)));
  });

  test('mlx-tts x86-emulated python → edge-tts default', () => {
    const x86Profile = makeProfile({ os: 'win32', arch: 'arm64', gpu: 'none', pythonArch: 'x86-emulated' });
    const rec = buildRecommendation('mlx-tts', x86Profile);
    assert.equal(rec.models[0]?.name, 'edge-tts');
    assert.equal(rec.unsupported, undefined);
  });
});

describe('recommendation matrix — Windows x64 with CUDA', () => {
  const profile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'cuda' });

  test('llm-postprocess → Qwen2.5-7B (GPU) with alternatives', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.equal(rec.models[0]?.name, 'Qwen/Qwen2.5-7B-Instruct');
    assert.ok(rec.models.length >= 2);
  });

  test('embedding-model → multilingual-e5-large (GPU)', () => {
    const rec = buildRecommendation('embedding-model', profile);
    assert.equal(rec.models[0]?.name, 'intfloat/multilingual-e5-large');
  });

  test('whisper-stt → faster-whisper turbo (GPU)', () => {
    const rec = buildRecommendation('whisper-stt', profile);
    assert.equal(rec.models[0]?.name, 'large-v3-turbo');
  });
});

describe('recommendation matrix — Linux x64 CPU only', () => {
  const profile = makeProfile({ os: 'linux', arch: 'x64', gpu: 'none' });

  test('llm-postprocess → 3B CPU model', () => {
    const rec = buildRecommendation('llm-postprocess', profile);
    assert.equal(rec.models[0]?.name, 'Qwen/Qwen2.5-3B-Instruct');
  });

  test('mlx-tts on Linux → edge-tts + piper', () => {
    const rec = buildRecommendation('mlx-tts', profile);
    assert.equal(rec.models[0]?.name, 'edge-tts');
    assert.ok(rec.models.some((m) => m.name === 'piper'));
  });
});

describe('recommendation matrix — Windows x64 TTS has piper', () => {
  test('mlx-tts on Windows → edge-tts default + sapi + piper alternatives', () => {
    const profile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'none' });
    const rec = buildRecommendation('mlx-tts', profile);
    assert.equal(rec.models[0]?.name, 'edge-tts');
    const names = rec.models.map((m) => m.name);
    assert.ok(names.includes('sapi'));
    assert.ok(names.includes('piper'));
  });
});

describe('recommendation matrix — match ordering', () => {
  test('GPU entry comes before generic entry (specificity matters)', () => {
    const cudaProfile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'cuda' });
    const noneProfile = makeProfile({ os: 'win32', arch: 'x64', gpu: 'none' });

    const cuda = findMatrixEntry('embedding-model', cudaProfile);
    const cpu = findMatrixEntry('embedding-model', noneProfile);

    assert.notEqual(cuda, cpu);
    assert.equal(cuda?.models?.[0]?.name, 'intfloat/multilingual-e5-large');
    assert.equal(cpu?.models?.[0]?.name, 'BAAI/bge-small-zh-v1.5');
  });
});

describe('recommendation matrix — unknown service', () => {
  test('returns unsupported with developer-facing message', () => {
    const rec = buildRecommendation('nonexistent-service', makeProfile());
    assert.equal(rec.models.length, 0);
    assert.ok(rec.unsupported);
    assert.match(rec.unsupported.reason, /nonexistent-service/);
  });
});

describe('recommendation matrix — models carry resource requirements', () => {
  test('each model has requirements.ramGb and requirements.diskGb', () => {
    const profile = makeProfile();
    const rec = buildRecommendation('llm-postprocess', profile);
    for (const m of rec.models) {
      assert.equal(typeof m.requirements.ramGb, 'number', `${m.name} missing ramGb`);
      assert.equal(typeof m.requirements.diskGb, 'number', `${m.name} missing diskGb`);
    }
  });
});
