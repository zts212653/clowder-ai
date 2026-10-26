#!/usr/bin/env node

// F331: fill in each film's duration and sha256 in packages/shared/src/feature-demos.json.
// Attaching a film is: put the cut in site/assets/demos, add one entry, run `pnpm demos:pin`.
// A cut that was already pinned never gets a new hash here: ship a changed cut under a new id.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOGUE_PATH = 'packages/shared/src/feature-demos.json';
export const ASSET_DIR = 'site/assets/demos';

function readBox(bytes, offset) {
  if (offset + 8 > bytes.length) return null;
  let size = bytes.readUInt32BE(offset);
  const type = bytes.toString('latin1', offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    size = Number(bytes.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = bytes.length - offset;
  }
  if (size < header || offset + size > bytes.length) return null;
  return { type, start: offset + header, end: offset + size };
}

function findBox(bytes, type, start, end) {
  for (let offset = start; offset < end; ) {
    const box = readBox(bytes, offset);
    if (!box) return null;
    if (box.type === type) return box;
    offset = box.end;
  }
  return null;
}

/** Reads the movie header (moov/mvhd) of an MP4 file; returns seconds rounded to 0.1. */
export function mp4DurationSeconds(bytes) {
  const moov = findBox(bytes, 'moov', 0, bytes.length);
  const mvhd = moov && findBox(bytes, 'mvhd', moov.start, moov.end);
  if (!mvhd) throw new Error('no moov/mvhd box');
  const version = bytes.readUInt8(mvhd.start);
  const timescale = bytes.readUInt32BE(mvhd.start + (version === 1 ? 20 : 12));
  const duration = version === 1 ? Number(bytes.readBigUInt64BE(mvhd.start + 24)) : bytes.readUInt32BE(mvhd.start + 16);
  if (!timescale) throw new Error('mvhd timescale is 0');
  return Math.round((duration / timescale) * 10) / 10;
}

const VIDEO_NAME = /^[a-z0-9][a-z0-9._-]*\.mp4$/;
const POSTER_NAME = /^[a-z0-9][a-z0-9._-]*\.(jpg|jpeg|png|webp)$/;

function entryProblems(id, entry) {
  const problems = [];
  for (const field of ['tipId', 'title', 'video', 'poster', 'tryPrompt']) {
    if (typeof entry[field] !== 'string' || !entry[field].trim()) problems.push(`${id}: missing ${field}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) problems.push(`${id}: id must be lowercase letters, digits and dashes`);
  if (typeof entry.video === 'string' && !VIDEO_NAME.test(entry.video)) {
    problems.push(`${id}: video must be an .mp4 file name in ${ASSET_DIR}`);
  }
  if (typeof entry.poster === 'string' && !POSTER_NAME.test(entry.poster)) {
    problems.push(`${id}: poster must be a .jpg, .png or .webp file name in ${ASSET_DIR}`);
  }
  return problems;
}

function nextCutId(id) {
  const match = /^(.*)-v(\d+)$/.exec(id);
  return match ? `${match[1]}-v${Number(match[2]) + 1}` : `${id}-v2`;
}

/** Returns errors for one entry and fills in its duration and sha256 when they are missing. */
function pinEntry(repoRoot, id, entry) {
  const errors = entryProblems(id, entry);
  if (errors.length > 0) return { errors, pinned: false };
  const video = resolve(repoRoot, ASSET_DIR, entry.video);
  if (!existsSync(video)) return { errors: [`${id}: ${ASSET_DIR}/${entry.video} not found`], pinned: false };
  if (!existsSync(resolve(repoRoot, ASSET_DIR, entry.poster))) {
    errors.push(`${id}: ${ASSET_DIR}/${entry.poster} not found`);
  }
  const bytes = readFileSync(video);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (entry.sha256 && entry.sha256 !== sha256) {
    errors.push(
      `${id}: ${entry.video} changed after it was published; add the new cut as ${nextCutId(id)} without sha256 and durationSeconds`,
    );
    return { errors, pinned: false };
  }
  let duration;
  try {
    duration = mp4DurationSeconds(bytes);
  } catch (error) {
    errors.push(`${id}: cannot read the duration of ${entry.video} (${error.message})`);
    return { errors, pinned: false };
  }
  if (entry.durationSeconds !== undefined && Math.abs(entry.durationSeconds - duration) > 0.15) {
    errors.push(`${id}: durationSeconds ${entry.durationSeconds} does not match ${entry.video} (${duration})`);
    return { errors, pinned: false };
  }
  if (entry.sha256 && entry.durationSeconds !== undefined) return { errors, pinned: false };
  entry.durationSeconds ??= duration;
  if (!entry.sha256) entry.sha256 = sha256;
  return { errors, pinned: true };
}

export function pinFeatureDemos({ repoRoot = defaultRepoRoot, write = true } = {}) {
  const cataloguePath = resolve(repoRoot, CATALOGUE_PATH);
  const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  const errors = [];
  const pinned = [];
  for (const [id, entry] of Object.entries(catalogue)) {
    const result = pinEntry(repoRoot, id, entry);
    errors.push(...result.errors);
    if (result.pinned) pinned.push(id);
  }
  if (errors.length === 0 && pinned.length > 0 && write) {
    writeFileSync(cataloguePath, `${JSON.stringify(catalogue, null, 2)}\n`);
  }
  return { errors, pinned };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { errors, pinned } = pinFeatureDemos({ write: !check });
  for (const error of errors) console.error(`[demos:pin] ${error}`);
  if (errors.length > 0) process.exit(1);
  if (check && pinned.length > 0) {
    console.error(`[demos:pin] not pinned yet: ${pinned.join(', ')}. Run pnpm demos:pin.`);
    process.exit(1);
  }
  console.log(pinned.length > 0 ? `[demos:pin] pinned ${pinned.join(', ')}` : '[demos:pin] all films pinned');
}
