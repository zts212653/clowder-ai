import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { invocationFetch } from './invocation-auth.js';

/**
 * Library Lifecycle Tools — F188 Phase I (AC-I4)
 *
 * MCP wrappers for collection lifecycle management: list and rebuild.
 * Archive (2026-11-09) and create/dry-run (2026-11-10) moved to the owner
 * library page, which calls the same /api/library routes.
 *
 * KD-8: callerCollections/collections NOT in MCP schema.
 * Visibility is server-derived; v1 sees all localhost-owned collections.
 */

import { deploymentDefaults } from '@cat-cafe/shared';
import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';
import { resolveInvocationEnv } from './invocation-auth.js';
import { libraryVerificationTool } from './library-verification-tool.js';

const defineTool = defineMcpMigrationFactory('library-lifecycle-tools.ts', undefined, {
  resourceFamily: 'library',
  authority: 'local-runtime',
});

function resolveApiUrl(): string {
  return resolveInvocationEnv('CAT_CAFE_API_URL') ?? deploymentDefaults.apiBaseUrl;
}

function libraryAuthHeaders(): Record<string, string> {
  return {
    'x-cat-cafe-user': resolveInvocationEnv('CAT_CAFE_USER_ID')?.trim() || 'default-user',
  };
}

// --- library_list ---

export const libraryListInputSchema = {
  status: z
    .enum(['registered', 'indexing', 'active', 'stale', 'blocked', 'archived'])
    .optional()
    .describe('Filter by collection status. Omit = all statuses.'),
};

interface CatalogItem {
  manifest: {
    id: string;
    displayName: string;
    sensitivity: string;
    status?: string;
    kind: string;
  };
  overview: { docCount?: number; wordCount?: number } | null;
}

export async function handleLibraryList(input: { status?: string | undefined }): Promise<ToolResult> {
  try {
    const response = await invocationFetch(`${resolveApiUrl()}/api/library/catalog`, { headers: libraryAuthHeaders() });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`library_list failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { collections: CatalogItem[] };
    let items = data.collections;
    if (input.status) {
      items = items.filter((c) => (c.manifest.status ?? 'active') === input.status);
    }
    return successResult(formatCatalog(items));
  } catch (err) {
    return errorResult(`library_list error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatCatalog(items: CatalogItem[]): string {
  const lines: string[] = [];
  lines.push(`Collections: ${items.length} found`);
  lines.push('');
  if (items.length === 0) {
    lines.push('(no collections)');
  } else {
    for (const item of items) {
      const m = item.manifest;
      const docs = item.overview?.docCount ?? '?';
      lines.push(`  ${m.id} — ${m.displayName} [${m.kind}] (${m.sensitivity}, ${m.status ?? 'active'}) ${docs} docs`);
    }
  }
  return lines.join('\n');
}

// --- library_rebuild ---

export const libraryRebuildInputSchema = {
  collectionId: z.string().describe('Collection ID (e.g. "domain:finance").'),
  force: z.boolean().optional().describe('Force full rebuild even if no changes detected.'),
};

export async function handleLibraryRebuild(input: {
  collectionId: string;
  force?: boolean | undefined;
}): Promise<ToolResult> {
  try {
    const body: Record<string, unknown> = {};
    if (input.force) body.force = true;
    const response = await invocationFetch(`${resolveApiUrl()}/api/library/${input.collectionId}/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...libraryAuthHeaders() },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`library_rebuild failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return successResult(formatRebuild(input.collectionId, data));
  } catch (err) {
    return errorResult(`library_rebuild error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatRebuild(id: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Rebuild complete: ${id}`);
  for (const [key, value] of Object.entries(data)) {
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

// --- exports ---

export const libraryLifecycleTools = [
  defineTool({
    name: 'cat_cafe_library_list',
    description: [
      'List all registered collections with status, document count, sensitivity.',
      'Use when: discovering available knowledge collections, checking health/status.',
      'Optional status filter: registered/indexing/active/stale/blocked/archived.',
      '',
      'v1 limitation (KD-8): no collection scoping. Sees all localhost-owned collections.',
    ].join('\n'),
    inputSchema: libraryListInputSchema,
    handler: handleLibraryList,
    governance: {
      implementationExport: 'handleLibraryList',
      action: 'command',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      targetExposure: 'lazy-discoverable',
    },
  }),
  defineTool({
    name: 'cat_cafe_library_rebuild',
    description: [
      'Rebuild the index for a collection — scans root directory for new/changed/deleted files.',
      'Use after: a collection is created on the owner library page, or files are added to a bound directory.',
      'Incremental by default; use force=true for full rebuild.',
    ].join('\n'),
    inputSchema: libraryRebuildInputSchema,
    handler: handleLibraryRebuild,
    governance: {
      implementationExport: 'handleLibraryRebuild',
      action: 'command',
      risk: { level: 'destructive', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  libraryVerificationTool,
] as const;
