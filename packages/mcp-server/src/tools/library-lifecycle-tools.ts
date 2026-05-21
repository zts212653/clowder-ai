/**
 * Library Lifecycle Tools — F188 Phase I (AC-I4)
 *
 * MCP wrappers for collection lifecycle management:
 * list, dry-run, create, rebuild, archive.
 *
 * KD-8: callerCollections/collections NOT in MCP schema.
 * Visibility is server-derived; v1 sees all localhost-owned collections.
 */

import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';

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
    const response = await fetch(`${API_URL}/api/library/catalog`);
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

// --- library_dry_run ---

export const libraryDryRunInputSchema = {
  root: z.string().describe('Absolute path to the directory to scan.'),
  exclude: z.array(z.string()).optional().describe('Glob patterns to exclude from scan.'),
};

export async function handleLibraryDryRun(input: {
  root: string;
  exclude?: readonly string[] | undefined;
}): Promise<ToolResult> {
  try {
    const body: Record<string, unknown> = { root: input.root };
    if (input.exclude) body.exclude = input.exclude;
    const response = await fetch(`${API_URL}/api/library/bind-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`library_dry_run failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as Record<string, unknown>;
    return successResult(formatDryRun(data));
  } catch (err) {
    return errorResult(`library_dry_run error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatDryRun(data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('Dry-run scan results:');
  for (const [key, value] of Object.entries(data)) {
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

// --- library_create ---

export const libraryCreateInputSchema = {
  kind: z.enum(['project', 'world', 'domain', 'research', 'global']).describe('Collection kind.'),
  name: z.string().describe('Short lowercase name (e.g. "finance"). Used in collection ID as <kind>:<name>.'),
  displayName: z.string().describe('Human-readable name shown in UI.'),
  root: z
    .string()
    .optional()
    .describe('Absolute path to bind. Omit for managed vault (auto-created under ~/.cat-cafe/library/sources/).'),
  sensitivity: z
    .enum(['public', 'internal', 'private', 'restricted'])
    .optional()
    .describe('Access level (default: private).'),
  exclude: z.array(z.string()).optional().describe('Glob patterns to exclude from indexing.'),
};

export async function handleLibraryCreate(input: {
  kind: string;
  name: string;
  displayName: string;
  root?: string | undefined;
  sensitivity?: string | undefined;
  exclude?: readonly string[] | undefined;
}): Promise<ToolResult> {
  const id = `${input.kind}:${input.name}`;
  try {
    const body: Record<string, unknown> = {
      id,
      kind: input.kind,
      name: input.name,
      displayName: input.displayName,
    };
    if (input.root) body.root = input.root;
    if (input.sensitivity) body.sensitivity = input.sensitivity;
    if (input.exclude) body.exclude = input.exclude;
    const response = await fetch(`${API_URL}/api/library/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`library_create failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { manifest: Record<string, unknown> };

    let rebuildWarning = '';
    try {
      const rebuildRes = await fetch(`${API_URL}/api/library/${id}/rebuild`, { method: 'POST' });
      if (!rebuildRes.ok) {
        rebuildWarning = `\n\nWarning: rebuild failed (${rebuildRes.status}). Run cat_cafe_library_rebuild manually.`;
      } else {
        const rebuildData = (await rebuildRes.json()) as Record<string, unknown>;
        if (rebuildData.blocked) {
          const secrets = rebuildData.secretFindings;
          rebuildWarning = `\n\nWarning: collection is BLOCKED — ${secrets} secret(s) detected during indexing. Review and remove secrets, then run cat_cafe_library_rebuild.`;
        }
      }
    } catch {
      rebuildWarning = '\n\nWarning: rebuild failed (network error). Run cat_cafe_library_rebuild manually.';
    }

    return successResult(formatCreated(data.manifest) + rebuildWarning);
  } catch (err) {
    return errorResult(`library_create error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatCreated(manifest: Record<string, unknown>): string {
  return [
    `Collection created: ${manifest.id}`,
    `  displayName: ${manifest.displayName}`,
    `  status: ${manifest.status ?? 'registered'}`,
    `  root: ${manifest.root}`,
    `  sensitivity: ${manifest.sensitivity}`,
    '',
    'Next: run cat_cafe_library_rebuild to index documents.',
  ].join('\n');
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
    const response = await fetch(`${API_URL}/api/library/${input.collectionId}/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// --- library_archive ---

export const libraryArchiveInputSchema = {
  collectionId: z.string().describe('Collection ID to archive (e.g. "domain:finance").'),
};

export async function handleLibraryArchive(input: { collectionId: string }): Promise<ToolResult> {
  try {
    const response = await fetch(`${API_URL}/api/library/${input.collectionId}/archive`, {
      method: 'POST',
    });
    if (!response.ok) {
      const text = await response.text();
      return errorResult(`library_archive failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { manifest: Record<string, unknown> };
    return successResult(`Collection ${data.manifest.id} archived (status: ${data.manifest.status}).`);
  } catch (err) {
    return errorResult(`library_archive error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- library_verify ---

export const libraryVerifyInputSchema = {
  anchor: z.string().min(1).describe('The document anchor to act on (e.g. F188, LL-029).'),
  action: z
    .enum(['confirm', 'mark_stale', 'escalate', 'dismiss_review'])
    .describe(
      'confirm: mark as reviewed (needs_review→reviewed). mark_stale: reset to needs_review. escalate: flag for human attention. dismiss_review: clear review_status.',
    ),
  actor: z.string().min(1).describe('Who is performing this action (cat ID or human identifier).'),
};

export async function handleLibraryVerify(input: {
  anchor: string;
  action: string;
  actor: string;
}): Promise<ToolResult> {
  try {
    const response = await fetch(`${API_URL}/api/f163/verification/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      previousStatus?: string;
      newStatus?: string;
    };
    if (!response.ok) {
      return errorResult(`library_verify failed (${response.status}): ${data.error ?? 'unknown'}`);
    }
    return successResult(
      `✅ Verification action applied: ${input.anchor} — ${input.action}\n` +
        `  Previous: ${data.previousStatus ?? 'null'} → New: ${data.newStatus ?? 'null'}`,
    );
  } catch (err) {
    return errorResult(`library_verify error: ${(err as Error).message}`);
  }
}

// --- exports ---

export const libraryLifecycleTools = [
  {
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
  },
  {
    name: 'cat_cafe_library_dry_run',
    description: [
      'Scan a directory and report what would be indexed (file count, size, secrets, scanner level).',
      'Use BEFORE cat_cafe_library_create to preview what a collection bind would include.',
      'Does NOT persist anything — safe to run multiple times.',
    ].join('\n'),
    inputSchema: libraryDryRunInputSchema,
    handler: handleLibraryDryRun,
  },
  {
    name: 'cat_cafe_library_create',
    description: [
      'Create a new collection. Two modes:',
      '  1. Bind existing dir: provide root path (e.g. ~/docs/finance)',
      '  2. Managed vault: omit root — auto-creates under ~/.cat-cafe/library/sources/',
      'Collection ID auto-derived as <kind>:<name>.',
      'After creation, run cat_cafe_library_rebuild to populate the index.',
    ].join('\n'),
    inputSchema: libraryCreateInputSchema,
    handler: handleLibraryCreate,
  },
  {
    name: 'cat_cafe_library_rebuild',
    description: [
      'Rebuild the index for a collection — scans root directory for new/changed/deleted files.',
      'Use after: creating a collection, adding files to a bound directory.',
      'Incremental by default; use force=true for full rebuild.',
    ].join('\n'),
    inputSchema: libraryRebuildInputSchema,
    handler: handleLibraryRebuild,
  },
  {
    name: 'cat_cafe_library_archive',
    description: [
      'Archive a collection — removes it from search/routing but preserves data.',
      'Archived collections are excluded from getRoutable and search results.',
      'Can be unarchived later via the REST API (POST /api/library/:id/unarchive).',
    ].join('\n'),
    inputSchema: libraryArchiveInputSchema,
    handler: handleLibraryArchive,
  },
  {
    name: 'cat_cafe_library_verify',
    description: [
      'Execute a verification action on a document: confirm, mark_stale, escalate, or dismiss_review.',
      'Use when: reviewing documents flagged by the verification migration or health report.',
      'Preconditions enforced: e.g. confirm only works on needs_review docs.',
    ].join('\n'),
    inputSchema: libraryVerifyInputSchema,
    handler: handleLibraryVerify,
  },
] as const;
