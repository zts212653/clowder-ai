#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, '..');
const vendorRoot = resolve(webRoot, 'public', 'vendor');

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function resolvePackageDir(pkgName) {
  try {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`, { paths: [webRoot] });
    return dirname(pkgJsonPath);
  } catch {
    const entryPath = require.resolve(pkgName, { paths: [webRoot] });
    let current = dirname(entryPath);
    while (current !== dirname(current)) {
      if (existsSync(resolve(current, 'package.json'))) return current;
      current = dirname(current);
    }
    throw new Error(`Cannot resolve package root for ${pkgName}`);
  }
}

function copyAsset(src, dest) {
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  console.log(`[sync-vendor-assets] ${src} -> ${dest}`);
}

function copyVadAssets() {
  const vadRoot = resolve(resolvePackageDir('@ricky0123/vad-web'), 'dist');
  const target = resolve(vendorRoot, 'vad');
  const files = ['silero_vad_v5.onnx', 'silero_vad_legacy.onnx', 'vad.worklet.bundle.min.js'];
  for (const file of files) {
    const src = resolve(vadRoot, file);
    if (!existsSync(src)) {
      throw new Error(`Missing VAD asset: ${src}`);
    }
    copyAsset(src, resolve(target, file));
  }
}

function copyOnnxRuntimeAssets() {
  const ortRoot = resolve(resolvePackageDir('onnxruntime-web'), 'dist');
  const target = resolve(vendorRoot, 'onnxruntime');
  const files = readdirSync(ortRoot).filter(
    (name) => name.startsWith('ort-wasm') && (name.endsWith('.wasm') || name.endsWith('.mjs')),
  );
  if (files.length === 0) {
    throw new Error(`No ort-wasm assets found in: ${ortRoot}`);
  }
  for (const file of files) {
    copyAsset(resolve(ortRoot, file), resolve(target, file));
  }
}

function copyEsbuildWasm() {
  const esbuildWasmPath = resolve(resolvePackageDir('esbuild-wasm'), 'esbuild.wasm');
  if (!existsSync(esbuildWasmPath)) {
    throw new Error(`Missing esbuild wasm: ${esbuildWasmPath}`);
  }
  copyAsset(esbuildWasmPath, resolve(vendorRoot, 'esbuild', 'esbuild.wasm'));
}

function main() {
  copyVadAssets();
  copyOnnxRuntimeAssets();
  copyEsbuildWasm();
}

try {
  main();
} catch (error) {
  console.error('[sync-vendor-assets] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
