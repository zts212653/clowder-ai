/**
 * Phase E: single canonical revision function — sha256 content hash with prefix.
 *
 * Extracted from profile-contract.ts because `node:crypto` breaks browser bundles
 * (collective-client esbuild platform:'browser' can't resolve Node builtins,
 * and memory-cue.ts → profile-contract.ts is in the barrel's transitive closure).
 *
 * INV-4: approve response, readCorpus, and cue snapshot must all use this
 * same function. Replaces scattered sha256 computations across the profile subsystem.
 */

import { createHash } from 'node:crypto';

export function profileRevisionOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}
