import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ONNX_RUNTIME_ASSETS,
  syncOnnxRuntimeAssets,
  syncVadAssets,
  VAD_RUNTIME_ASSETS,
} from '../scripts/sync-vendor-assets.mjs';

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function makeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-vendor-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vadSrc = join(root, 'src-vad');
  const ortSrc = join(root, 'src-ort');
  const vendor = join(root, 'public/vendor');
  mkdirSync(vadSrc, { recursive: true });
  mkdirSync(ortSrc, { recursive: true });

  writeFileSync(join(vadSrc, 'silero_vad_v5.onnx'), 'v5-model-bytes');
  writeFileSync(join(vadSrc, 'silero_vad_legacy.onnx'), 'legacy-model-bytes');
  writeFileSync(join(vadSrc, 'vad.worklet.bundle.min.js'), 'worklet-min-bytes');
  writeFileSync(join(vadSrc, 'vad.worklet.bundle.dev.js'), 'worklet-dev-bytes');

  for (const name of [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jspi.wasm',
    'ort-wasm-simd-threaded.jspi.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.asyncify.mjs',
  ]) {
    writeFileSync(join(ortSrc, name), `bytes:${name}`);
  }
  return { root, vadSrc, ortSrc, vadTarget: join(vendor, 'vad'), ortTarget: join(vendor, 'onnxruntime') };
}

describe('sync-vendor-assets VAD and ONNX Runtime selection', () => {
  it('syncs only the active v5 VAD and CPU SIMD-threaded ONNX pair into a clean vendor directory', (t) => {
    const fx = makeFixture(t);
    assert.deepEqual(syncVadAssets({ vadRoot: fx.vadSrc, target: fx.vadTarget }), [...VAD_RUNTIME_ASSETS]);
    assert.deepEqual(syncOnnxRuntimeAssets({ ortRoot: fx.ortSrc, target: fx.ortTarget }), [...ONNX_RUNTIME_ASSETS]);

    assert.deepEqual(readdirSync(fx.vadTarget).sort(), ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']);
    assert.equal(readFileSync(join(fx.vadTarget, 'silero_vad_v5.onnx'), 'utf8'), 'v5-model-bytes');
    assert.equal(readFileSync(join(fx.vadTarget, 'vad.worklet.bundle.min.js'), 'utf8'), 'worklet-min-bytes');

    assert.deepEqual(readdirSync(fx.ortTarget).sort(), ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']);
    assert.equal(
      readFileSync(join(fx.ortTarget, 'ort-wasm-simd-threaded.wasm'), 'utf8'),
      'bytes:ort-wasm-simd-threaded.wasm',
    );
    assert.equal(
      readFileSync(join(fx.ortTarget, 'ort-wasm-simd-threaded.mjs'), 'utf8'),
      'bytes:ort-wasm-simd-threaded.mjs',
    );
  });

  it('prunes stale managed legacy/variant files on re-sync while preserving unrelated neighbors and staying idempotent', (t) => {
    const fx = makeFixture(t);
    mkdirSync(fx.vadTarget, { recursive: true });
    mkdirSync(fx.ortTarget, { recursive: true });

    // Seed stale variants from an older sync alongside unrelated local files.
    writeFileSync(join(fx.vadTarget, 'silero_vad_legacy.onnx'), 'stale-legacy');
    writeFileSync(join(fx.vadTarget, 'custom-vad.onnx'), 'keep-neighbor-vad');
    for (const stale of [
      'ort-wasm-simd-threaded.jsep.wasm',
      'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jspi.wasm',
      'ort-wasm-simd-threaded.jspi.mjs',
      'ort-wasm-simd-threaded.asyncify.wasm',
      'ort-wasm-simd-threaded.asyncify.mjs',
    ]) {
      writeFileSync(join(fx.ortTarget, stale), 'stale-variant');
    }
    writeFileSync(join(fx.ortTarget, 'custom-model.onnx'), 'keep-custom-model');
    writeFileSync(join(fx.ortTarget, 'ort-wasm-notes.txt'), 'keep-notes');

    syncVadAssets({ vadRoot: fx.vadSrc, target: fx.vadTarget });
    syncOnnxRuntimeAssets({ ortRoot: fx.ortSrc, target: fx.ortTarget });

    assert.deepEqual(readdirSync(fx.vadTarget).sort(), [
      'custom-vad.onnx',
      'silero_vad_v5.onnx',
      'vad.worklet.bundle.min.js',
    ]);
    assert.equal(existsSync(join(fx.vadTarget, 'silero_vad_legacy.onnx')), false);
    assert.equal(readFileSync(join(fx.vadTarget, 'custom-vad.onnx'), 'utf8'), 'keep-neighbor-vad');

    assert.deepEqual(readdirSync(fx.ortTarget).sort(), [
      'custom-model.onnx',
      'ort-wasm-notes.txt',
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
    ]);
    assert.equal(readFileSync(join(fx.ortTarget, 'custom-model.onnx'), 'utf8'), 'keep-custom-model');
    assert.equal(readFileSync(join(fx.ortTarget, 'ort-wasm-notes.txt'), 'utf8'), 'keep-notes');

    const firstHashes = {
      vad: VAD_RUNTIME_ASSETS.map((f) => sha256(join(fx.vadTarget, f))),
      ort: ONNX_RUNTIME_ASSETS.map((f) => sha256(join(fx.ortTarget, f))),
    };

    // Repeated sync stays idempotent with identical directory contents and hashes.
    syncVadAssets({ vadRoot: fx.vadSrc, target: fx.vadTarget });
    syncOnnxRuntimeAssets({ ortRoot: fx.ortSrc, target: fx.ortTarget });
    assert.deepEqual(
      VAD_RUNTIME_ASSETS.map((f) => sha256(join(fx.vadTarget, f))),
      firstHashes.vad,
    );
    assert.deepEqual(
      ONNX_RUNTIME_ASSETS.map((f) => sha256(join(fx.ortTarget, f))),
      firstHashes.ort,
    );
  });

  it('fails closed when a required runtime asset is missing from the source package', (t) => {
    const fx = makeFixture(t);
    rmSync(join(fx.vadSrc, 'silero_vad_v5.onnx'));
    assert.throws(() => syncVadAssets({ vadRoot: fx.vadSrc, target: fx.vadTarget }), /Missing VAD asset/);

    rmSync(join(fx.ortSrc, 'ort-wasm-simd-threaded.wasm'));
    assert.throws(
      () => syncOnnxRuntimeAssets({ ortRoot: fx.ortSrc, target: fx.ortTarget }),
      /Missing ONNX Runtime asset/,
    );
  });

  it('syncs exact required assets from the locked installed @ricky0123/vad-web and onnxruntime-web packages', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'sync-vendor-real-pkg-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const vadTarget = join(root, 'vad');
    const ortTarget = join(root, 'onnxruntime');

    syncVadAssets({ target: vadTarget });
    syncOnnxRuntimeAssets({ target: ortTarget });

    assert.deepEqual(readdirSync(vadTarget).sort(), [...VAD_RUNTIME_ASSETS].sort());
    assert.deepEqual(readdirSync(ortTarget).sort(), [...ONNX_RUNTIME_ASSETS].sort());
    for (const file of VAD_RUNTIME_ASSETS) {
      assert.ok(readFileSync(join(vadTarget, file)).byteLength > 0, `${file} must be non-empty`);
    }
    for (const file of ONNX_RUNTIME_ASSETS) {
      assert.ok(readFileSync(join(ortTarget, file)).byteLength > 0, `${file} must be non-empty`);
    }
  });
});
