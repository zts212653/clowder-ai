/**
 * Config Route
 * GET   /api/config              — 返回运行时配置快照
 * PATCH /api/config              — 热更新可变配置 (F4)
 * GET   /api/config/env-summary  — 返回用户可配的 env 变量及当前值 (F12)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { collectConfigSnapshot } from '../config/ConfigRegistry.js';
import { configStore } from '../config/ConfigStore.js';
import {
  clearRuntimeDefaultCatId,
  getDefaultCatId,
  getOwnerUserId,
  hasRuntimeDefaultCatOverride,
  setRuntimeDefaultCatId,
} from '../config/cat-config-loader.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import type { ConfigSnapshot } from '../config/config-snapshot.js';
import {
  buildEnvSummary,
  ENV_CATEGORIES,
  filterSensitiveEditableKeys,
  hasSensitiveEditableVars,
  isEditableEnvVarName,
} from '../config/env-registry.js';
import { updateRuntimeCoCreator } from '../config/runtime-cat-catalog.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import { configCatOrderRoutes } from './config-cat-order.js';

const patchSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const envPatchSchema = z.object({
  updates: z.array(z.object({ name: z.string().min(1), value: z.string().nullable() })).min(1),
});

const coCreatorPatchSchema = z.object({
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)),
  mentionPatterns: z.array(z.string().trim().min(1)).min(1),
  avatar: z.string().trim().nullable().optional(),
  color: z
    .object({
      primary: z.string().min(1),
      secondary: z.string().min(1),
    })
    .nullable()
    .optional(),
});

const runtimeStatusQuerySchema = z.object({
  category: z.string().optional(),
});

interface ConfigRoutesOptions {
  auditLog?: {
    append(input: { type: string; threadId?: string; data: Record<string, unknown> }): Promise<unknown>;
  };
  envFilePath?: string;
  projectRoot?: string;
}

function getSnapshotValue(snapshot: ConfigSnapshot, key: string): unknown {
  const path = configStore.getSnapshotPath(key);
  if (!path) return undefined;
  return path.reduce<unknown>((current, segment) => {
    if (current == null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, snapshot);
}

function resolveOperator(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof first === 'string') return first.trim();
  }
  return null;
}

export function formatEnvFileValue(value: string): string {
  const escapedControlChars = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (/^[A-Za-z0-9_./:@-]+$/.test(escapedControlChars)) return escapedControlChars;
  return `"${escapedControlChars
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')}"`;
}

export function applyEnvUpdatesToFile(contents: string, updates: Map<string, string | null>): string {
  const lines = contents === '' ? [] : contents.split(/\r?\n/);
  const seen = new Set<string>();
  const nextLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const name = match[1]!;
    if (!updates.has(name)) {
      nextLines.push(line);
      continue;
    }
    seen.add(name);
    const value = updates.get(name);
    if (value == null || value === '') continue;
    nextLines.push(`${name}=${formatEnvFileValue(value)}`);
  }

  for (const [name, value] of updates) {
    if (seen.has(name) || value == null || value === '') continue;
    nextLines.push(`${name}=${formatEnvFileValue(value)}`);
  }

  const normalized = nextLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

export async function configRoutes(app: FastifyInstance, opts: ConfigRoutesOptions = {}): Promise<void> {
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const projectRoot = opts.projectRoot ?? resolveActiveProjectRoot();
  const envFilePath = opts.envFilePath ?? resolve(projectRoot, '.env');

  await app.register(configCatOrderRoutes, { projectRoot });

  app.get('/api/config', async () => ({
    config: collectConfigSnapshot(),
  }));

  app.patch('/api/config', async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const before = collectConfigSnapshot();
    const oldValue = getSnapshotValue(before, parsed.data.key);
    try {
      configStore.set(parsed.data.key, parsed.data.value);
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
    const after = collectConfigSnapshot();
    const newValue = getSnapshotValue(after, parsed.data.key);
    const riskLevel = configStore.getRiskLevel(parsed.data.key) ?? 'standard';

    if (riskLevel === 'high') {
      request.log.warn(
        {
          key: parsed.data.key,
          operator,
        },
        'high-risk config key updated',
      );
    }

    try {
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: {
          key: parsed.data.key,
          oldValue,
          newValue,
          operator,
          riskLevel,
          source: configStore.source(parsed.data.key) ?? 'default',
        },
      });
    } catch (err) {
      request.log.warn({ err, key: parsed.data.key }, 'config audit append failed');
    }

    return { config: after };
  });

  const handleCoCreatorPatch = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = coCreatorPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    try {
      updateRuntimeCoCreator(projectRoot, {
        name: parsed.data.name,
        aliases: parsed.data.aliases,
        mentionPatterns: parsed.data.mentionPatterns,
        ...(parsed.data.avatar !== undefined ? { avatar: parsed.data.avatar } : {}),
        ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
      });
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }

    const next = collectConfigSnapshot();
    try {
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: {
          target: 'coCreator',
          operator,
          name: next.coCreator.name,
          mentionPatterns: next.coCreator.mentionPatterns,
        },
      });
    } catch (err) {
      request.log.warn({ err }, 'coCreator config audit append failed');
    }

    return { config: next };
  };

  app.patch('/api/config/co-creator', handleCoCreatorPatch);

  // Backward-compat: old path delegates to same handler (deprecated)
  app.patch('/api/config/owner', async (request, reply) => {
    request.log.warn('DEPRECATED: /api/config/owner — use /api/config/co-creator');
    return handleCoCreatorPatch(request, reply);
  });

  app.get('/api/config/env-summary', async () => {
    const apiCwd = process.cwd();
    const home = os.homedir();
    return {
      categories: ENV_CATEGORIES,
      variables: buildEnvSummary(),
      paths: {
        projectRoot,
        homeDir: home,
        dataDirs: {
          auditLogs: resolve(apiCwd, process.env.AUDIT_LOG_DIR ?? './data/audit-logs'),
          runtimeLogs: resolve(apiCwd, './data/logs/api'),
          cliArchive: resolve(apiCwd, process.env.CLI_RAW_ARCHIVE_DIR ?? './data/cli-raw-archive'),
          redisDevSandbox: resolve(home, '.cat-cafe/redis-dev-sandbox'),
          uploads: resolve(apiCwd, process.env.UPLOAD_DIR ?? './uploads'),
        },
      },
    };
  });

  app.patch('/api/config/env', async (request, reply) => {
    const parsed = envPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const updates = new Map<string, string | null>();
    for (const update of parsed.data.updates) {
      if (!isEditableEnvVarName(update.name)) {
        reply.status(400);
        return { error: `Env var '${update.name}' is not editable from Hub` };
      }
      updates.set(update.name, update.value);
    }

    // Owner gate: sensitive-editable vars require EXPLICIT owner config (F136 trust anchor)
    const touchesSensitive = hasSensitiveEditableVars(updates.keys());
    if (touchesSensitive) {
      const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim();
      if (!ownerId) {
        reply.status(403);
        return { error: 'Sensitive env write requires DEFAULT_OWNER_USER_ID to be configured' };
      }
      if (operator !== ownerId) {
        reply.status(403);
        return { error: 'Sensitive env vars can only be modified by the owner' };
      }
    }

    // Snapshot old values for no-op detection
    const oldValues = new Map<string, string | undefined>();
    for (const name of updates.keys()) {
      oldValues.set(name, process.env[name]);
    }

    const current = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
    const next = applyEnvUpdatesToFile(current, updates);
    writeFileSync(envFilePath, next, 'utf8');

    for (const [name, value] of updates) {
      if (value == null || value === '') delete process.env[name];
      else process.env[name] = value;
    }

    // Only emit if at least one key actually changed
    const changedKeys = [...updates.entries()]
      .filter(([name, value]) => (value ?? '') !== (oldValues.get(name) ?? ''))
      .map(([name]) => name);
    if (changedKeys.length > 0) {
      configEventBus.emitChange({
        source: 'env',
        scope: 'key',
        changedKeys,
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
    }

    try {
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: {
          target: '.env',
          keys: [...updates.keys()],
          operator,
        },
      });
      // Separate audit trail for sensitive env writes (sensitive keys only, no values)
      if (touchesSensitive) {
        await auditLog.append({
          type: AuditEventTypes.ENV_SENSITIVE_WRITE,
          data: {
            keys: filterSensitiveEditableKeys(updates.keys()),
            operator,
          },
        });
      }
    } catch (err) {
      request.log.warn({ err, keys: [...updates.keys()] }, 'env config audit append failed');
    }

    return { ok: true, envFilePath, summary: buildEnvSummary() };
  });

  // ── F154 AC-A4: Default cat runtime override (owner-gated) ──────────

  app.get('/api/config/default-cat', async () => ({
    catId: getDefaultCatId(),
    isOverride: hasRuntimeDefaultCatOverride(),
  }));

  const defaultCatPutSchema = z.object({
    catId: z.string().min(1).nullable(),
  });

  app.put('/api/config/default-cat', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    if (operator !== getOwnerUserId()) {
      reply.status(403);
      return { error: 'Only the owner can change the default cat' };
    }

    const parsed = defaultCatPutSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    if (parsed.data.catId === null) {
      clearRuntimeDefaultCatId();
      return { ok: true, catId: getDefaultCatId(), isOverride: false };
    }

    // Validate catId is registered
    if (!catRegistry.has(parsed.data.catId)) {
      reply.status(400);
      return { error: `Unknown catId: ${parsed.data.catId}` };
    }

    setRuntimeDefaultCatId(parsed.data.catId);
    return { ok: true, catId: parsed.data.catId, isOverride: true };
  });
}
