/**
 * Config Route
 * GET   /api/config              — 返回运行时配置快照
 * PATCH /api/config              — 热更新可变配置 (F4)
 * GET   /api/config/env-summary  — 返回用户可配的 env 变量及当前值 (F12)
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { collectConfigSnapshot } from '../config/ConfigRegistry.js';
import { configStore } from '../config/ConfigStore.js';
import type { ConfigSnapshot } from '../config/config-snapshot.js';
import { buildEnvSummary, ENV_CATEGORIES } from '../config/env-registry.js';
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

interface ConfigRoutesOptions {
  auditLog?: {
    append(input: { type: string; threadId?: string; data: Record<string, unknown> }): Promise<unknown>;
  };
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

export async function configRoutes(app: FastifyInstance, opts: ConfigRoutesOptions = {}): Promise<void> {
  const auditLog = opts.auditLog ?? getEventAuditLog();

  app.get('/api/config', async () => ({
    config: collectConfigSnapshot(),
  }));

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
        projectRoot: MONOREPO_ROOT,
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
}
