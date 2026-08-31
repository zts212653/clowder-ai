/**
 * Callback Documentation Routes
 * On-demand fallback endpoints for MCP callback API reference and rich block
 * usage rules. Primary source of truth is in cat-cafe-skills/ (Skills system).
 *
 * These endpoints are unauthenticated — they serve static documentation
 * that is safe to expose. Kept as fallback for when skills are not readable.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { RICH_BLOCK_RULES } from '../domains/cats/services/context/rich-block-rules.js';
import { loadObjectiveRegistry } from '../infrastructure/harness-eval/objective-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Strip YAML frontmatter (between --- delimiters) from markdown content. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? content.slice(match[0].length).trimStart() : content;
}

/** Resolve path to a refs file in cat-cafe-skills/refs/. */
function refsPath(fileName: string): string {
  // From packages/api/src/routes/ → go up 4 levels to project root
  return resolve(__dirname, '..', '..', '..', '..', 'cat-cafe-skills', 'refs', fileName);
}

/** F257 #3: resolve the objective registry YAML (docs/harness-feedback/objectives/). */
function objectiveRegistryPath(): string {
  return resolve(__dirname, '..', '..', '..', '..', 'docs', 'harness-feedback', 'objectives', 'registry.yaml');
}

export interface CallbackDocsRoutesOptions {
  /** Test seam: override the objective registry path (defaults to the shipped location). */
  objectiveRegistryPath?: string;
}

/**
 * Register documentation endpoints (fallback for Skills system).
 * No auth required — these return static reference text.
 */
export const registerCallbackDocsRoutes: FastifyPluginAsync<CallbackDocsRoutesOptions> = async (app, opts) => {
  const registryPath = opts.objectiveRegistryPath ?? objectiveRegistryPath();
  // Rich block usage rules
  app.get('/api/callbacks/rich-block-rules', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return { rules: RICH_BLOCK_RULES };
  });

  // F257 #3: objective registry — read-only discovery for report_harness_signal
  // objectiveId (so cats stop doing archaeology). Definition layer (id/statement).
  // Fail-closed (2a R1 P1-2): an unreadable/malformed/invalid catalog returns 503,
  // never a cacheable empty list that would masquerade as "no objectives".
  app.get('/api/callbacks/objectives', async (request, reply) => {
    const result = await loadObjectiveRegistry(registryPath);
    if (!result.ok) {
      // 2a R2 P2-1: this endpoint is UNAUTHENTICATED. The loader's reason contains the
      // registry path + fs errno — log it server-side, but return a stable, path-free 503
      // so a caller (and the MCP tool that forwards response.text()) never learns the
      // install path / layout. The MCP tool still only needs to recognize the 503.
      request.log.error({ reason: result.error }, '[F257] objective registry unavailable');
      reply.code(503);
      return { error: 'Objective registry unavailable' };
    }
    reply.header('cache-control', 'public, max-age=3600');
    return {
      registryVersion: result.registry.registryVersion,
      objectives: result.registry.objectives,
      evaluationModels: result.registry.evaluationModels,
    };
  });

  // MCP callback instructions — reads refs file (SOT moved from skill to refs/)
  app.get('/api/callbacks/instructions', async (_request, reply) => {
    try {
      const raw = await readFile(refsPath('mcp-callbacks.md'), 'utf-8');
      const instructions = stripFrontmatter(raw);
      reply.header('cache-control', 'public, max-age=3600');
      return { instructions };
    } catch {
      reply.code(503);
      return { error: 'Refs file not readable. Ensure cat-cafe-skills/refs/mcp-callbacks.md exists.' };
    }
  });
};
