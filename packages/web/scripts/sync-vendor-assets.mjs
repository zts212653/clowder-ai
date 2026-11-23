#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, unwatchFile, watch, watchFile } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentDefaults } from '../../shared/src/deployment-defaults.ts';
import { FEATURE_DEMOS } from '../../shared/src/feature-demos.ts';
import { syncBrandManifest } from './sync-brand-manifest.mjs';
import { copyAsset } from './vendor-asset-publication.mjs';
import { appGlobalCssFiles, syncStylesheets } from './vendor-stylesheets.mjs';

export { copyAsset } from './vendor-asset-publication.mjs';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, '..');
const vendorRoot = resolve(webRoot, 'public', 'vendor');
const sharedUiCssPath = resolve(webRoot, '../ui/src/styles.css');

export { appGlobalCssFiles } from './vendor-stylesheets.mjs';

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

export const VAD_RUNTIME_ASSETS = Object.freeze(['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']);
export const ONNX_RUNTIME_ASSETS = Object.freeze(['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']);

function removeStaleManagedAssets(target, allowedFiles, isManaged) {
  if (!existsSync(target)) return;
  for (const existing of readdirSync(target)) {
    if (isManaged(existing) && !allowedFiles.has(existing)) {
      rmSync(resolve(target, existing), { force: true });
    }
  }
}

export function syncVadAssets({
  vadRoot = resolve(resolvePackageDir('@ricky0123/vad-web'), 'dist'),
  target = resolve(vendorRoot, 'vad'),
} = {}) {
  // useVadInterrupt explicitly uses Silero VAD v5; skip the unused legacy model.
  for (const file of VAD_RUNTIME_ASSETS) {
    const src = resolve(vadRoot, file);
    if (!existsSync(src)) {
      throw new Error(`Missing VAD asset: ${src}`);
    }
    copyAsset(src, resolve(target, file));
  }
  removeStaleManagedAssets(target, new Set(VAD_RUNTIME_ASSETS), (name) => name === 'silero_vad_legacy.onnx');
  return [...VAD_RUNTIME_ASSETS];
}

export function syncOnnxRuntimeAssets({
  ortRoot = resolve(resolvePackageDir('onnxruntime-web'), 'dist'),
  target = resolve(vendorRoot, 'onnxruntime'),
} = {}) {
  // @ricky0123/vad-web/dist/real-time-vad.js imports onnxruntime-web/wasm, which only
  // loads the CPU SIMD-threaded WASM pair; omit the unused JSEP/JSPI/Asyncify variants (~66 MB).
  for (const file of ONNX_RUNTIME_ASSETS) {
    const src = resolve(ortRoot, file);
    if (!existsSync(src)) {
      throw new Error(`Missing ONNX Runtime asset: ${src}`);
    }
    copyAsset(src, resolve(target, file));
  }
  removeStaleManagedAssets(
    target,
    new Set(ONNX_RUNTIME_ASSETS),
    (name) => name.startsWith('ort-wasm') && (name.endsWith('.wasm') || name.endsWith('.mjs')),
  );
  return [...ONNX_RUNTIME_ASSETS];
}

function copyVadAssets() {
  syncVadAssets();
}

function copyOnnxRuntimeAssets() {
  syncOnnxRuntimeAssets();
}

function copyEsbuildWasm() {
  const esbuildWasmPath = resolve(resolvePackageDir('esbuild-wasm'), 'esbuild.wasm');
  if (!existsSync(esbuildWasmPath)) {
    throw new Error(`Missing esbuild wasm: ${esbuildWasmPath}`);
  }
  copyAsset(esbuildWasmPath, resolve(vendorRoot, 'esbuild', 'esbuild.wasm'));
}

function copyStylesheets() {
  syncStylesheets(webRoot);
}

function appGlobalCssPaths(file) {
  return {
    src: resolve(webRoot, 'src', 'app', file),
    dest: resolve(vendorRoot, 'app', file),
  };
}

export function pollVendorCssFiles(paths, changed, interval = 1000) {
  return paths.map((src) => {
    const listener = () => changed(src);
    watchFile(src, { persistent: true, interval }, listener);
    return { close: () => unwatchFile(src, listener) };
  });
}

function watchAppGlobalCss() {
  for (const cssFile of appGlobalCssFiles) {
    const { src } = appGlobalCssPaths(cssFile);
    if (!existsSync(src)) {
      throw new Error(`Missing app global CSS: ${src}`);
    }
  }
  // Match Next/Watchpack's existing polling mode when native file-event admission is exhausted.
  if (process.env.WATCHPACK_POLLING === 'true' || /^[1-9]\d*$/.test(process.env.WATCHPACK_POLLING ?? '')) {
    const interval = Math.max(500, Math.min(10000, Number(process.env.WATCHPACK_POLLING) || 1000));
    const paths = [...appGlobalCssFiles.map((file) => appGlobalCssPaths(file).src), sharedUiCssPath];
    console.log(`[sync-vendor-assets] polling ${paths.length} app CSS files every ${interval}ms`);
    return pollVendorCssFiles(
      paths,
      () => {
        try {
          copyStylesheets();
        } catch (error) {
          console.error(
            '[sync-vendor-assets] CSS polling failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      interval,
    );
  }
  return [
    ...pollVendorCssFiles([sharedUiCssPath], () => {
      try {
        copyStylesheets();
      } catch (error) {
        console.error('[sync-vendor-assets] shared UI CSS failed:', String(error));
      }
    }),
    watch(resolve(webRoot, 'src', 'app'), { persistent: true }, (_eventType, filename) => {
      const file = typeof filename === 'string' ? filename : filename?.toString();
      const exact = file && appGlobalCssFiles.includes(file);
      if (file && !exact && !file.endsWith('.css') && !file.includes('.css.')) return;
      try {
        copyStylesheets();
      } catch (error) {
        console.error('[sync-vendor-assets] watch failed:', error instanceof Error ? error.message : String(error));
      }
    }),
  ];
}

/**
 * @param {{demos?: Record<string, {assetSource: string, posterAssetSource: string, src: string, poster: string, sha256: string}>, repoRoot?: string, publicRoot?: string}} [options]
 */
export function syncFeatureDemoAssets({
  demos = FEATURE_DEMOS,
  repoRoot = resolve(webRoot, '../..'),
  publicRoot = resolve(webRoot, 'public'),
} = {}) {
  // F331: publish every fixed cut from the same catalogue used by the UI and statistics.
  for (const demo of Object.values(demos)) {
    const bytes = readFileSync(resolve(repoRoot, demo.assetSource));
    if (createHash('sha256').update(bytes).digest('hex') !== demo.sha256) {
      throw new Error('Published demo bytes changed: register a new cut/version before shipping.');
    }
    for (const [source, target] of [
      [demo.assetSource, demo.src],
      [demo.posterAssetSource, demo.poster],
    ]) {
      copyAsset(resolve(repoRoot, source), resolve(publicRoot, target.slice(1)));
    }
  }
}

function syncVendorAssets() {
  syncFeatureDemoAssets();
  syncBrandManifest(webRoot, deploymentDefaults.brand);
  copyVadAssets();
  copyOnnxRuntimeAssets();
  copyEsbuildWasm();
  copyStylesheets();
}

function closeWatchers(watchers) {
  for (const watcher of watchers) {
    watcher.close();
  }
}

function runWatchMode(commandArgs) {
  syncVendorAssets();
  const watchers = watchAppGlobalCss();

  if (commandArgs.length === 0) {
    console.log('[sync-vendor-assets] watching app global CSS');
    return;
  }

  const child = spawn(commandArgs[0], commandArgs.slice(1), {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  let closing = false;

  const close = (signal) => {
    if (closing) return;
    closing = true;
    closeWatchers(watchers);
    if (!child.killed) child.kill(signal);
  };

  process.once('SIGINT', () => close('SIGINT'));
  process.once('SIGTERM', () => close('SIGTERM'));
  child.once('error', (error) => {
    closeWatchers(watchers);
    console.error('[sync-vendor-assets] command failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    closeWatchers(watchers);
    if (signal) {
      process.exit(128);
    }
    process.exit(typeof code === 'number' ? code : 0);
  });
}

function parseArgs(argv) {
  if (argv[0] !== '--watch') {
    return { watchMode: false, commandArgs: [] };
  }
  const separator = argv.indexOf('--');
  return {
    watchMode: true,
    commandArgs: separator === -1 ? argv.slice(1) : argv.slice(separator + 1),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { watchMode, commandArgs } = parseArgs(process.argv.slice(2));
    if (watchMode) {
      runWatchMode(commandArgs);
    } else {
      syncVendorAssets();
    }
  } catch (error) {
    console.error('[sync-vendor-assets] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
