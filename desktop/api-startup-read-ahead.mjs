import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const maxBytes = 64 * 1024 * 1024;
const inside = (root, file) => file.startsWith(root + path.sep);
const programPath = /^(?:node_modules\/|packages\/[a-z][a-z0-9-]*\/(?:dist|node_modules)\/).+\.(?:[cm]?js|json)$/;

export function isStartupProgramPath(relative) {
  return (
    typeof relative === 'string' &&
    programPath.test(relative) &&
    relative.length <= 1024 &&
    !/[:<>|?*\0\\]/.test(relative) &&
    !relative.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function validManifest(value) {
  if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.entrySha256)) return false;
  if (!Array.isArray(value.files) || value.files.length > 2048) return false;
  let bytes = 0;
  const seen = new Set();
  return value.files.every((file) => {
    if (!isStartupProgramPath(file?.relative)) return false;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || seen.has(file.relative)) return false;
    seen.add(file.relative);
    bytes += file.bytes;
    return bytes <= maxBytes;
  });
}

// Hints read immutable JS/JSON bytes only. No imports, writes, resolver changes or
// authentication reads. Missing/stale hints preserve the ordinary loader path.
export async function readAheadApi(apiEntry, { io = fs, budgetMs = 15000 } = {}) {
  const began = performance.now();
  const result = { status: 'skipped', files: 0, bytes: 0, errors: 0, budgetMs };
  if (!apiEntry || path.basename(apiEntry) !== 'index.desktop.js') return result;
  const entry = path.resolve(apiEntry);
  const root = path.resolve(entry, '../../../..');
  if (path.relative(root, entry).split(path.sep).join('/') !== 'packages/api/dist/index.desktop.js') return result;
  const controller = new AbortController();
  const { signal } = controller;
  let timer;
  const operation = async () => {
    let manifest;
    try {
      const rootIdentity = await io.realpath(root);
      const file = await io.realpath(path.join(path.dirname(entry), '.startup-read-ahead.json'));
      if (!inside(rootIdentity, file)) return { ...result, status: 'invalid' };
      const stat = await io.stat(file);
      if (!stat.isFile() || stat.size > 512 * 1024) return { ...result, status: 'invalid' };
      manifest = JSON.parse(await io.readFile(file, { encoding: 'utf8', signal }));
      if (!validManifest(manifest)) return { ...result, status: 'invalid' };
    } catch (error) {
      return { ...result, status: error.code === 'ENOENT' ? 'skipped' : 'invalid' };
    }
    const canonicalRoot = await io.realpath(root);
    const canonicalEntry = await io.realpath(entry);
    if (!inside(canonicalRoot, canonicalEntry)) return { ...result, status: 'invalid' };
    const entryStat = await io.stat(canonicalEntry);
    if (!entryStat.isFile() || entryStat.size > maxBytes) return { ...result, status: 'invalid' };
    const plannedBytes =
      entryStat.size +
      manifest.files
        .filter((file) => file.relative !== 'packages/api/dist/index.desktop.js')
        .reduce((sum, file) => sum + file.bytes, 0);
    if (plannedBytes > maxBytes) return { ...result, status: 'invalid' };
    if (signal.aborted) return result;
    const entryBytes = await io.readFile(canonicalEntry, { signal });
    if (createHash('sha256').update(entryBytes).digest('hex') !== manifest.entrySha256)
      return { ...result, status: 'invalid' };
    result.files++;
    result.bytes += entryBytes.length;
    let cursor = 0;
    const worker = async () => {
      while (!signal.aborted && cursor < manifest.files.length) {
        const file = manifest.files[cursor++];
        const candidate = path.join(root, file.relative);
        try {
          const canonical = await io.realpath(candidate);
          if (!inside(canonicalRoot, canonical)) throw new Error('External program hint');
          if (!isStartupProgramPath(path.relative(canonicalRoot, canonical).split(path.sep).join('/')))
            throw new Error('Program hint redirected into data');
          // The entry was already read for identity, so do not read it twice.
          if (canonical === canonicalEntry) continue;
          const stat = await io.stat(canonical);
          if (!stat.isFile() || stat.size !== file.bytes) throw new Error('Changed program hint');
          if (signal.aborted) break;
          const data = await io.readFile(canonical, { signal });
          if (!signal.aborted) {
            result.files++;
            result.bytes += data.length;
          }
        } catch {
          if (!signal.aborted) result.errors++;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return { ...result, status: result.errors ? 'partial' : 'ready' };
  };
  try {
    return {
      ...(await Promise.race([
        operation().catch(() => ({ ...result, status: 'partial' })),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ ...result, status: 'budget' });
          }, budgetMs);
        }),
      ])),
      elapsedMs: Math.round(performance.now() - began),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
