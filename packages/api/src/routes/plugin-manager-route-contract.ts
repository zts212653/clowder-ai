import { isAbsolute } from 'node:path';
import { PluginArchiveReplacementConfirmationSchema } from '@cat-cafe/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuditEventTypes, type EventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import {
  ExternalPluginRuntimeError,
  LocalPluginPackageAdmissionError,
  PluginArchiveReplacementError,
  PluginLifecycleError,
  PluginManagerPackageAssetError,
  PluginManagerServiceError,
} from '../domains/plugin/index.js';
import { OfficialPluginInstallError } from '../domains/plugin/official-package-errors.js';

export function packageAssetStatus(code: PluginManagerPackageAssetError['code']): number {
  if (code === 'PLUGIN_NOT_FOUND' || code === 'ASSET_NOT_FOUND') return 404;
  if (code === 'CATALOG_UNAVAILABLE') return 503;
  return 422;
}

export const pluginIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const catalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const lifecycleRevisionSchema = z.number().int().safe().min(1);
export const canonicalDigestSchema = z.string().refine((value) => {
  if (!value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
});

export const searchQuerySchema = z.object({ q: z.string().trim().max(200) }).strict();
export const disconnectBindingSchema = z
  .object({
    key: z.string().min(1).max(1024),
    threadId: z.string().min(1).max(256),
    createdAt: z.number().int().safe().min(0),
    confirmed: z.literal(true),
  })
  .strict();
export const catalogInstallSchema = z
  .object({
    source: z.object({ kind: z.literal('catalog'), catalogId: catalogIdSchema }).strict(),
    expectedVersion: z.string().trim().min(1).max(128),
    expectedDigest: canonicalDigestSchema,
  })
  .strict();
export const localInstallSchema = z
  .object({
    source: z
      .object({
        kind: z.literal('local-directory'),
        path: z.string().trim().min(1).max(4_096).refine(isAbsolute),
      })
      .strict(),
  })
  .strict();
export const archiveInstallSchema = z
  .object({
    source: z
      .object({ kind: z.literal('local-archive'), path: z.string().trim().min(1).max(4_096).refine(isAbsolute) })
      .strict(),
    replacement: PluginArchiveReplacementConfirmationSchema.optional(),
  })
  .strict();
export const gitInstallSchema = z
  .object({
    source: z
      .object({
        kind: z.literal('git'),
        url: z.string().trim().min(1).max(4_096),
        marketplace: z
          .object({
            sourceId: z.string().regex(/^[a-f0-9]{24}$/),
            commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
            path: z.string().regex(/^packages\/[a-z0-9-]+$/),
            pluginId: pluginIdSchema,
            version: z.string().min(1).max(128),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export const installSchema = z.union([
  catalogInstallSchema,
  localInstallSchema,
  archiveInstallSchema,
  gitInstallSchema,
]);
export const setEnabledSchema = z.object({ enabled: z.boolean(), expectedRevision: lifecycleRevisionSchema }).strict();
export const uninstallSchema = z.object({ expectedRevision: lifecycleRevisionSchema }).strict();
export const configureSchema = z
  .object({
    expectedRevision: lifecycleRevisionSchema,
    updates: z
      .array(
        z
          .object({
            key: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
            value: z.string().max(65_536).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
export const contributionCallSchema = z
  .object({
    contributionId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    toolName: z.string().trim().min(1).max(256),
    arguments: z.record(z.unknown()),
  })
  .strict();

export function invalidRequest(reply: FastifyReply) {
  return reply.status(400).send({ error: 'Invalid plugin manager request', code: 'INVALID_REQUEST' });
}

export function managerServiceStatus(code: PluginManagerServiceError['code']): number {
  if (code === 'PLUGIN_NOT_FOUND') return 404;
  if (code === 'INVALID_CONFIGURATION') return 400;
  if (code === 'STALE_REVISION' || code === 'CATALOG_MISMATCH' || code === 'ACTION_NOT_ALLOWED') return 409;
  return 503;
}

export async function appendConfigurationAudit(
  auditLog: Pick<EventAuditLog, 'append'>,
  input: {
    readonly operator: string;
    readonly pluginId: string;
    readonly expectedRevision: number;
    readonly keys: readonly string[];
  },
): Promise<void> {
  await auditLog.append({
    type: AuditEventTypes.CONFIG_UPDATED,
    data: {
      target: 'plugin-configuration-contribution',
      stage: 'requested',
      operator: input.operator,
      pluginId: input.pluginId,
      expectedRevision: input.expectedRevision,
      keys: [...input.keys],
    },
  });
}

export async function appendContributionCallAudit(
  auditLog: Pick<EventAuditLog, 'append'>,
  input: {
    readonly operator: string;
    readonly pluginId: string;
    readonly contributionId: string;
    readonly toolName: string;
  },
): Promise<void> {
  await auditLog.append({
    type: AuditEventTypes.CONFIG_UPDATED,
    data: {
      target: 'plugin-contribution',
      stage: 'requested',
      operator: input.operator,
      pluginId: input.pluginId,
      contributionId: input.contributionId,
      toolName: input.toolName,
    },
  });
}

export function officialInstallStatus(code: OfficialPluginInstallError['code']): number {
  if (code === 'UNKNOWN_CATALOG_ID' || code === 'INSTANCE_NOT_FOUND') return 404;
  if (code === 'STALE_CATALOG' || code === 'STALE_REVISION' || code === 'DATA_DIRECTORY_IN_USE') return 409;
  if (code === 'QUARANTINE_UNAVAILABLE') return 503;
  return 422;
}

export function sendManagerError(reply: FastifyReply, error: unknown) {
  if (error instanceof PluginArchiveReplacementError) {
    return reply.status(409).send({
      error: error.message,
      code: error.code,
      ...(error.replacement ? { replacement: error.replacement } : {}),
    });
  }
  if (
    error instanceof PluginLifecycleError &&
    (error.code === 'UPDATE_RESUME_FAILED' || error.code === 'UPDATE_ROLLBACK_RESUME_FAILED')
  ) {
    return reply.status(503).send({ error: error.message, code: error.code });
  }
  if (error instanceof PluginManagerServiceError) {
    return reply.status(managerServiceStatus(error.code)).send({ error: error.message, code: error.code });
  }
  if (error instanceof LocalPluginPackageAdmissionError) {
    const conflict = error.code === 'PACKAGE_DIGEST_MISMATCH' || error.code === 'DATA_DIRECTORY_IN_USE';
    const status = error.code === 'QUARANTINE_UNAVAILABLE' ? 503 : conflict ? 409 : 422;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof OfficialPluginInstallError) {
    return reply.status(officialInstallStatus(error.code)).send({ error: error.message, code: error.code });
  }
  return reply.status(500).send({ error: 'Plugin manager operation failed', code: 'PLUGIN_MANAGER_FAILED' });
}

export function sendContributionError(reply: FastifyReply, error: unknown) {
  if (error instanceof ExternalPluginRuntimeError) {
    const status = error.code === 'DELIVERY_REJECTED' ? 409 : error.code === 'PROTOCOL_VIOLATION' ? 422 : 503;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  return reply.status(500).send({ error: 'Plugin contribution operation failed', code: 'CONTRIBUTION_FAILED' });
}

export async function appendMutationAudit(
  auditLog: Pick<EventAuditLog, 'append'>,
  input: {
    readonly operator: string;
    readonly operation: 'install' | 'update' | 'set-enabled' | 'uninstall';
    readonly pluginId?: string;
    readonly sourceKind?: 'catalog' | 'git' | 'local-directory' | 'local-archive';
    readonly expectedRevision?: number;
  },
): Promise<void> {
  await auditLog.append({
    type: AuditEventTypes.CONFIG_UPDATED,
    data: {
      target: 'plugin-manager',
      stage: 'requested',
      operator: input.operator,
      operation: input.operation,
      ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
      ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    },
  });
}
