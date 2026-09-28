import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  PluginManagerConfigureRequest,
  PluginManagerInstallRequest,
  PluginManagerSetEnabledRequest,
  PluginManagerUninstallRequest,
} from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuditEventTypes,
  type EventAuditLog,
  getEventAuditLog,
} from '../domains/cats/services/orchestration/EventAuditLog.js';
import {
  BuiltinPluginContributionError,
  type BuiltinPluginContributionSupervisor,
  LocalPluginPackageAdmissionError,
  PluginManagerPackageAssetError,
  type PluginManagerPackageAssetPort,
  type PluginManagerPackageDocumentationPort,
  type PluginManagerService,
  PluginManagerServiceError,
} from '../domains/plugin/index.js';
import { MAX_PLUGIN_PACKAGE_BYTES } from '../domains/plugin/official-package-archive.js';
import { OfficialPluginInstallError } from '../domains/plugin/official-package-errors.js';
import type { CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import {
  pluginAccessError,
  requirePluginOwnerLocalAccess,
  requirePluginReadAccess,
  requirePluginWriteAccess,
} from './plugin-access-guards.js';

type PluginManagerRouteService = Pick<
  PluginManagerService,
  'list' | 'search' | 'get' | 'install' | 'configure' | 'setEnabled' | 'uninstall'
>;

export interface PluginManagerRouteOptions {
  readonly manager: PluginManagerRouteService;
  readonly contributions?: Pick<BuiltinPluginContributionSupervisor, 'listPluginTools' | 'callPluginTool'>;
  readonly asset?: PluginManagerPackageAssetPort;
  readonly documentation?: PluginManagerPackageDocumentationPort;
  readonly auditLog?: Pick<EventAuditLog, 'append'>;
  readonly callbackRegistry?: CallbackAuthRegistry;
}

function packageAssetStatus(code: PluginManagerPackageAssetError['code']): number {
  if (code === 'PLUGIN_NOT_FOUND' || code === 'ASSET_NOT_FOUND') return 404;
  if (code === 'CATALOG_UNAVAILABLE') return 503;
  return 422;
}

const pluginIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const catalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const lifecycleRevisionSchema = z.number().int().safe().min(1);
const canonicalDigestSchema = z.string().refine((value) => {
  if (!value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
});

const searchQuerySchema = z.object({ q: z.string().trim().max(200) }).strict();
const catalogInstallSchema = z
  .object({
    source: z.object({ kind: z.literal('catalog'), catalogId: catalogIdSchema }).strict(),
    expectedVersion: z.string().trim().min(1).max(128),
    expectedDigest: canonicalDigestSchema,
  })
  .strict();
const localInstallSchema = z
  .object({
    source: z
      .object({
        kind: z.enum(['local-directory', 'local-archive']),
        path: z.string().trim().min(1).max(4_096).refine(isAbsolute),
      })
      .strict(),
  })
  .strict();
const installSchema = z.union([catalogInstallSchema, localInstallSchema]);
const setEnabledSchema = z.object({ enabled: z.boolean(), expectedRevision: lifecycleRevisionSchema }).strict();
const uninstallSchema = z.object({ expectedRevision: lifecycleRevisionSchema }).strict();
const configureSchema = z
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
const contributionCallSchema = z
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

function invalidRequest(reply: FastifyReply) {
  return reply.status(400).send({ error: 'Invalid plugin manager request', code: 'INVALID_REQUEST' });
}

function managerServiceStatus(code: PluginManagerServiceError['code']): number {
  if (code === 'PLUGIN_NOT_FOUND') return 404;
  if (code === 'INVALID_CONFIGURATION') return 400;
  if (code === 'STALE_REVISION' || code === 'CATALOG_MISMATCH' || code === 'ACTION_NOT_ALLOWED') return 409;
  return 503;
}

async function appendConfigurationAudit(
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

async function appendContributionCallAudit(
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

function officialInstallStatus(code: OfficialPluginInstallError['code']): number {
  if (code === 'UNKNOWN_CATALOG_ID' || code === 'INSTANCE_NOT_FOUND') return 404;
  if (code === 'STALE_CATALOG' || code === 'STALE_REVISION') return 409;
  if (code === 'QUARANTINE_UNAVAILABLE') return 503;
  return 422;
}

function sendManagerError(reply: FastifyReply, error: unknown) {
  if (error instanceof PluginManagerServiceError) {
    return reply.status(managerServiceStatus(error.code)).send({ error: error.message, code: error.code });
  }
  if (error instanceof LocalPluginPackageAdmissionError) {
    const status = error.code === 'QUARANTINE_UNAVAILABLE' ? 503 : error.code === 'PACKAGE_DIGEST_MISMATCH' ? 409 : 422;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof OfficialPluginInstallError) {
    return reply.status(officialInstallStatus(error.code)).send({ error: error.message, code: error.code });
  }
  return reply.status(500).send({ error: 'Plugin manager operation failed', code: 'PLUGIN_MANAGER_FAILED' });
}

function sendContributionError(reply: FastifyReply, error: unknown) {
  if (error instanceof BuiltinPluginContributionError) {
    const status =
      error.code === 'CONTRIBUTION_NOT_ACTIVE' ? 409 : error.code === 'UNSUPPORTED_CONTRIBUTION' ? 422 : 503;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  return reply.status(500).send({ error: 'Plugin contribution operation failed', code: 'CONTRIBUTION_FAILED' });
}

class PluginManagerUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'AUDIT_UNAVAILABLE' | 'INVALID_UPLOAD' | 'NO_FILE' | 'PACKAGE_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'PluginManagerUploadError';
  }
}

function translateUploadReadError(error: unknown): PluginManagerUploadError {
  if (error instanceof PluginManagerUploadError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new PluginManagerUploadError(413, 'PACKAGE_TOO_LARGE', 'Plugin package exceeds the Host size limit');
  }
  return new PluginManagerUploadError(400, 'INVALID_UPLOAD', 'Invalid upload');
}

async function readPluginUpload(request: FastifyRequest): Promise<Buffer> {
  let bytes: Buffer | undefined;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'file' || bytes !== undefined) {
        if (part.type === 'file') await part.toBuffer();
        throw new PluginManagerUploadError(400, 'INVALID_UPLOAD', 'Invalid upload');
      }
      bytes = await part.toBuffer();
    }
  } catch (error) {
    throw translateUploadReadError(error);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new PluginManagerUploadError(400, 'NO_FILE', 'No plugin archive uploaded');
  }
  return bytes;
}

async function installPluginUpload(
  bytes: Buffer,
  operator: string,
  manager: PluginManagerRouteService,
  auditLog: Pick<EventAuditLog, 'append'>,
): Promise<unknown> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-plugin-upload-'));
  const archivePath = join(temporaryRoot, 'package.tgz');
  try {
    await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await appendMutationAudit(auditLog, {
        operator,
        operation: 'install',
        sourceKind: 'local-archive',
      });
    } catch {
      throw new PluginManagerUploadError(503, 'AUDIT_UNAVAILABLE', 'Plugin audit log is unavailable');
    }
    return await manager.install({ source: { kind: 'local-archive', path: archivePath } });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function appendMutationAudit(
  auditLog: Pick<EventAuditLog, 'append'>,
  input: {
    readonly operator: string;
    readonly operation: 'install' | 'set-enabled' | 'uninstall';
    readonly pluginId?: string;
    readonly sourceKind?: 'catalog' | 'local-directory' | 'local-archive';
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

export function registerPluginManagerRoutes(app: FastifyInstance, options: PluginManagerRouteOptions): void {
  const auditLog = options.auditLog ?? getEventAuditLog();
  if (options.callbackRegistry) {
    // This route performs its own read/write policy split below. The generic callback hook
    // cannot infer an MCP tool name from a non-callback REST path.
    registerCallbackAuthHook(app, options.callbackRegistry, { enforceToolExecutionPolicy: false });
  }
  const accessOptions = { allowVerifiedCallbackPrincipal: true } as const;

  app.get('/api/plugin-manager/plugins', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    try {
      return await options.manager.list();
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get('/api/plugin-manager/plugins/search', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply);
    try {
      return await options.manager.search(parsed.data.q);
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.get<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/:pluginId/icon', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
    if (!parsedId.success) return invalidRequest(reply);
    if (!options.asset) {
      return reply.status(503).send({ error: 'Plugin package assets are unavailable', code: 'ASSET_UNAVAILABLE' });
    }
    try {
      const asset = await options.asset.readIcon(parsedId.data);
      return reply
        .type(asset.contentType)
        .header('ETag', asset.etag)
        .header('Cache-Control', 'private, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
        .send(asset.bytes);
    } catch (error) {
      if (error instanceof PluginManagerPackageAssetError) {
        return reply.status(packageAssetStatus(error.code)).send({ error: error.message, code: error.code });
      }
      return reply.status(500).send({ error: 'Plugin package asset failed', code: 'ASSET_FAILED' });
    }
  });

  app.get<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/documentation',
    async (request, reply) => {
      const access = requirePluginOwnerLocalAccess(request, 'read');
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      if (!parsedId.success) return invalidRequest(reply);
      if (!options.documentation) {
        return reply
          .status(503)
          .send({ error: 'Plugin package documentation is unavailable', code: 'DOCUMENTATION_UNAVAILABLE' });
      }
      try {
        const readmeMarkdown = await options.documentation.readReadme(parsedId.data);
        return readmeMarkdown === undefined ? {} : { readmeMarkdown };
      } catch (error) {
        if (error instanceof PluginManagerPackageAssetError) {
          return reply.status(packageAssetStatus(error.code)).send({ error: error.message, code: error.code });
        }
        return reply.status(500).send({ error: 'Plugin package documentation failed', code: 'DOCUMENTATION_FAILED' });
      }
    },
  );

  app.get<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/contributions/tools',
    async (request, reply) => {
      const access = requirePluginReadAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      if (!parsedId.success) return invalidRequest(reply);
      if (!options.contributions) {
        return reply
          .status(503)
          .send({ error: 'Plugin contributions are unavailable', code: 'CONTRIBUTION_UNAVAILABLE' });
      }
      try {
        return { pluginId: parsedId.data, tools: await options.contributions.listPluginTools(parsedId.data) };
      } catch (error) {
        return sendContributionError(reply, error);
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/contributions/call',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = contributionCallSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      if (!options.contributions) {
        return reply
          .status(503)
          .send({ error: 'Plugin contributions are unavailable', code: 'CONTRIBUTION_UNAVAILABLE' });
      }
      try {
        await appendContributionCallAudit(auditLog, {
          operator: access.operator,
          pluginId: parsedId.data,
          contributionId: parsed.data.contributionId,
          toolName: parsed.data.toolName,
        });
      } catch {
        return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
      }
      try {
        return await options.contributions.callPluginTool(
          parsedId.data,
          parsed.data.contributionId,
          parsed.data.toolName,
          parsed.data.arguments,
        );
      } catch (error) {
        return sendContributionError(reply, error);
      }
    },
  );

  app.get<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/:pluginId', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
    if (!parsedId.success) return invalidRequest(reply);
    try {
      return await options.manager.get(parsedId.data);
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.post('/api/plugin-manager/plugins/install', async (request, reply) => {
    const access = requirePluginWriteAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply);
    const installRequest = parsed.data as PluginManagerInstallRequest;
    try {
      await appendMutationAudit(auditLog, {
        operator: access.operator,
        operation: 'install',
        sourceKind: installRequest.source.kind,
      });
    } catch {
      return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
    }
    try {
      const result = await options.manager.install(installRequest);
      return reply.status(201).send(result);
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/contributions/configuration',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = configureSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      const mutation = parsed.data as PluginManagerConfigureRequest;
      try {
        await appendConfigurationAudit(auditLog, {
          operator: access.operator,
          pluginId: parsedId.data,
          expectedRevision: mutation.expectedRevision,
          keys: mutation.updates.map((update) => update.key),
        });
      } catch {
        return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
      }
      try {
        return await options.manager.configure(parsedId.data, mutation);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/set-enabled',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = setEnabledSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      const mutation = parsed.data as PluginManagerSetEnabledRequest;
      try {
        await appendMutationAudit(auditLog, {
          operator: access.operator,
          operation: 'set-enabled',
          pluginId: parsedId.data,
          expectedRevision: mutation.expectedRevision,
        });
      } catch {
        return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
      }
      try {
        return await options.manager.setEnabled(parsedId.data, mutation);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/uninstall',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = uninstallSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      const mutation = parsed.data as PluginManagerUninstallRequest;
      try {
        await appendMutationAudit(auditLog, {
          operator: access.operator,
          operation: 'uninstall',
          pluginId: parsedId.data,
          expectedRevision: mutation.expectedRevision,
        });
      } catch {
        return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
      }
      try {
        return await options.manager.uninstall(parsedId.data, mutation);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );
}

/** Browser transport adapter for the same local-archive Manager install operation. */
export const pluginManagerUploadRoutes: FastifyPluginAsync<PluginManagerRouteOptions> = async (app, options) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_PLUGIN_PACKAGE_BYTES, files: 1, fields: 0, parts: 1 },
  });
  const auditLog = options.auditLog ?? getEventAuditLog();

  app.post('/api/plugin-manager/plugins/install/upload', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);

    try {
      const bytes = await readPluginUpload(request);
      const installed = await installPluginUpload(bytes, access.operator, options.manager, auditLog);
      return reply.status(201).send(installed);
    } catch (error) {
      if (error instanceof PluginManagerUploadError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }
      return sendManagerError(reply, error);
    }
  });
};
