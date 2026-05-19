#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, '..');
const vendorRoot = resolve(webRoot, 'public', 'vendor');
const appGlobalCssFiles = [
  'theme-tokens.css',
  'console-shell.css',
  'console-controls.css',
  'connector-tokens.css',
  'werewolf-theme.css',
];

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

function copyXtermCss() {
  const xtermCssPath = resolve(resolvePackageDir('@xterm/xterm'), 'css', 'xterm.css');
  if (!existsSync(xtermCssPath)) {
    throw new Error(`Missing xterm CSS: ${xtermCssPath}`);
  }
  copyAsset(xtermCssPath, resolve(vendorRoot, 'xterm', 'xterm.css'));
}

function appGlobalCssPaths(file) {
  return {
    src: resolve(webRoot, 'src', 'app', file),
    dest: resolve(vendorRoot, 'app', file),
  };
}

function copyAppGlobalCssFile(file) {
  const { src, dest } = appGlobalCssPaths(file);
  if (!existsSync(src)) {
    throw new Error(`Missing app global CSS: ${src}`);
  }
  copyAsset(src, dest);
}

function copyAppGlobalCss() {
  for (const file of appGlobalCssFiles) {
    copyAppGlobalCssFile(file);
  }
}

function watchAppGlobalCss() {
  for (const cssFile of appGlobalCssFiles) {
    const { src } = appGlobalCssPaths(cssFile);
    if (!existsSync(src)) {
      throw new Error(`Missing app global CSS: ${src}`);
    }
  }
  return [
    watch(resolve(webRoot, 'src', 'app'), { persistent: true }, (_eventType, filename) => {
      const file = typeof filename === 'string' ? filename : filename?.toString();
      const exact = file && appGlobalCssFiles.includes(file);
      if (file && !exact && !file.endsWith('.css') && !file.includes('.css.')) return;
      try {
        if (exact) {
          copyAppGlobalCssFile(file);
        } else {
          copyAppGlobalCss();
        }
      } catch (error) {
        console.error('[sync-vendor-assets] watch failed:', error instanceof Error ? error.message : String(error));
      }
    }),
  ];
}

function syncVendorAssets() {
  copyVadAssets();
  copyOnnxRuntimeAssets();
  copyEsbuildWasm();
  copyXtermCss();
  copyAppGlobalCss();
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
