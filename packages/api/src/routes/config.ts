/**
 * Config Route
 * GET   /api/config              — 返回运行时配置快照
 * PATCH /api/config              — 热更新可变配置 (F4)
 * GET   /api/config/env-summary  — 返回用户可配的 env 变量及当前值 (F12)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { collectConfigSnapshot } from '../config/ConfigRegistry.js';
import { configStore } from '../config/ConfigStore.js';
import type { ConfigSnapshot } from '../config/config-snapshot.js';
import { buildEnvSummary, ENV_CATEGORIES, isEditableEnvVarName } from '../config/env-registry.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';

/** Walk up from CWD to find pnpm-workspace.yaml — the monorepo root. */
function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const MONOREPO_ROOT = findMonorepoRoot();

const patchSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const envPatchSchema = z.object({
  updates: z.array(z.object({ name: z.string().min(1), value: z.string().nullable() })).min(1),
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

function formatEnvFileValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function applyEnvUpdatesToFile(contents: string, updates: Map<string, string | null>): string {
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

  const normalized = nextLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

export async function configRoutes(app: FastifyInstance, opts: ConfigRoutesOptions = {}): Promise<void> {
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const projectRoot = opts.projectRoot ?? MONOREPO_ROOT;
  const envFilePath = opts.envFilePath ?? resolve(projectRoot, '.env');

  app.get('/api/config', async () => ({
    config: collectConfigSnapshot(),
  }));

  app.get('/api/config/runtime-status', async (request, reply) => {
    const parsed = runtimeStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }
    const category = parsed.data.category ?? 'hindsight';
    if (category !== 'hindsight') {
      reply.status(400);
      return { error: `Unsupported category '${category}'` };
    }

    const snapshot = collectConfigSnapshot();
    return {
      runtimeStatus: {
        category: 'hindsight',
        engine: {
          // NOTE: v0.2 control-plane phase.
          // "effective" currently mirrors "configured" until route-level engine dispatch
          // (Task 3) is fully wired. Keep fields separate for forward compatibility.
          reflect: {
            configured: snapshot.hindsight.engine.reflect,
            effective: snapshot.hindsight.engine.reflect,
            source: configStore.source('hindsight.engine.reflect') ?? 'default',
          },
          retainExtraction: {
            configured: snapshot.hindsight.engine.retainExtraction,
            effective: snapshot.hindsight.engine.retainExtraction,
            source: configStore.source('hindsight.engine.retainExtraction') ?? 'default',
          },
          allowNativeFallback: snapshot.hindsight.engine.allowNativeFallback,
        },
        recallDefaults: {
          budget: {
            value: snapshot.hindsight.recallDefaults.budget,
            source: configStore.source('hindsight.recallDefaults.budget') ?? 'default',
          },
          tagsMatch: {
            value: snapshot.hindsight.recallDefaults.tagsMatch,
            source: configStore.source('hindsight.recallDefaults.tagsMatch') ?? 'default',
          },
          limit: {
            value: snapshot.hindsight.recallDefaults.limit,
            source: configStore.source('hindsight.recallDefaults.limit') ?? 'default',
          },
        },
        reflect: {
          dispositionMode: {
            value: snapshot.hindsight.reflect.dispositionMode,
            source: configStore.source('hindsight.reflect.dispositionMode') ?? 'default',
          },
        },
        service: {
          baseUrl: snapshot.hindsight.baseUrl,
          bank: snapshot.hindsight.sharedBank,
          mode: snapshot.hindsight.service.mode,
        },
        codex: {
          model: snapshot.codexExecution.model,
          authMode: snapshot.codexExecution.authMode,
          passModelArg: snapshot.codexExecution.passModelArg,
        },
      },
    };
  });

  app.patch('/api/config', async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
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
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
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

    const current = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
    const next = applyEnvUpdatesToFile(current, updates);
    writeFileSync(envFilePath, next, 'utf8');

    for (const [name, value] of updates) {
      if (value == null || value === '') delete process.env[name];
      else process.env[name] = value;
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
    } catch (err) {
      request.log.warn({ err, keys: [...updates.keys()] }, 'env config audit append failed');
    }

    return { ok: true, envFilePath, summary: buildEnvSummary() };
  });
}
