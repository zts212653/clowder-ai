import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginInstanceRecord } from '../domains/plugin/host-inventory/types.js';
import type { OfficialPluginCatalogEntry } from '../domains/plugin/official-catalog.js';
import type { OfficialPluginCatalogProvider } from '../domains/plugin/official-catalog-provider.js';
import type { OfficialPluginAuthPort } from '../domains/plugin/official-plugin-auth.js';
import {
  OfficialPluginHistoryImportError,
  type OfficialPluginHistoryImportPort,
} from '../domains/plugin/official-plugin-history-import.js';
import { pluginAccessError, requirePluginWriteAccess } from './plugin-access-guards.js';

interface OfficialPluginHistoryRouteOptions {
  readonly inventory: PluginInventoryStore;
  readonly auth?: OfficialPluginAuthPort;
  readonly historyImport?: OfficialPluginHistoryImportPort;
  readonly catalogProvider: OfficialPluginCatalogProvider;
}

interface OfficialPluginHistoryImportRequest {
  readonly Params: { instanceId: string };
  readonly Body: { expectedRevision?: unknown; reference?: unknown };
}

interface HistoryImportBody {
  readonly expectedRevision: number;
  readonly reference: string;
}

interface HistoryImportTarget {
  readonly entry: OfficialPluginCatalogEntry;
  readonly instance: PluginInstanceRecord;
  readonly historyImport: OfficialPluginHistoryImportPort;
}

class HistoryImportRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HistoryImportRouteError';
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function requireHistoryImportBody(value: unknown): HistoryImportBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidReference();
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'expectedRevision,reference') throw invalidReference();
  if (
    typeof body.expectedRevision !== 'number' ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1 ||
    typeof body.reference !== 'string' ||
    body.reference.length < 1 ||
    body.reference.length > 2_048 ||
    body.reference !== body.reference.trim() ||
    containsControlCharacter(body.reference)
  ) {
    throw invalidReference();
  }
  return { expectedRevision: body.expectedRevision, reference: body.reference };
}

function invalidReference(): HistoryImportRouteError {
  return new HistoryImportRouteError(
    400,
    'INVALID_REFERENCE',
    'expectedRevision and one bounded Feishu Minutes reference are required',
  );
}

async function resolveHistoryImportTarget(
  options: OfficialPluginHistoryRouteOptions,
  instanceId: string,
): Promise<HistoryImportTarget> {
  const [catalog, snapshot] = await Promise.all([options.catalogProvider.snapshot(), options.inventory.snapshot()]);
  const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === instanceId);
  const entry = instance ? catalog.entries.find((candidate) => candidate.pluginId === instance.pluginId) : undefined;
  if (!entry || !instance || entry.catalogId !== 'feishu-meeting-intake' || !options.historyImport) {
    throw new HistoryImportRouteError(
      404,
      'HISTORY_IMPORT_UNAVAILABLE',
      'Historical import is unavailable for this official plugin',
    );
  }
  return { entry, instance, historyImport: options.historyImport };
}

function assertCurrentHistoryImportAuthority(target: HistoryImportTarget, expectedRevision: number): void {
  const { entry, instance } = target;
  if (instance.lifecycleRevision !== expectedRevision) {
    throw new HistoryImportRouteError(409, 'STALE_REVISION', 'Official plugin state changed');
  }
  if (
    instance.packageDigest !== entry.packageDigest ||
    instance.lifecycleState !== 'installed' ||
    instance.configReadiness !== 'ready' ||
    instance.activationState !== 'enabled' ||
    instance.runtimeState !== 'healthy'
  ) {
    throw new HistoryImportRouteError(
      409,
      'INSTANCE_NOT_READY',
      'Historical import requires the current healthy official plugin runtime',
    );
  }
}

async function assertOwnerAuthConnected(
  auth: OfficialPluginAuthPort | undefined,
  target: HistoryImportTarget,
): Promise<void> {
  if (!auth) {
    throw new HistoryImportRouteError(503, 'AUTH_UNAVAILABLE', 'Official plugin authentication is unavailable');
  }
  const status = await auth.status({ entry: target.entry, instance: target.instance });
  if (status.status !== 'connected') {
    throw new HistoryImportRouteError(409, 'AUTH_REQUIRED', 'Connect the owner Feishu account before importing');
  }
}

function historyImportServiceStatus(code: OfficialPluginHistoryImportError['code']): number {
  if (code === 'INVALID_REFERENCE') return 400;
  if (code === 'SOURCE_NOT_FOUND') return 404;
  if (code === 'STALE_REVISION' || code === 'INSTANCE_NOT_READY') return 409;
  return 502;
}

function sendHistoryImportError(reply: FastifyReply, error: unknown) {
  if (error instanceof HistoryImportRouteError) {
    return reply.status(error.status).send({ error: error.message, code: error.code });
  }
  if (error instanceof OfficialPluginHistoryImportError) {
    return reply.status(historyImportServiceStatus(error.code)).send({ error: error.message, code: error.code });
  }
  return reply.status(502).send({
    error: 'Unable to import historical Feishu Minute',
    code: 'SOURCE_UNAVAILABLE',
  });
}

export function registerOfficialPluginHistoryRoutes(
  app: FastifyInstance,
  options: OfficialPluginHistoryRouteOptions,
): void {
  app.post<OfficialPluginHistoryImportRequest>(
    '/api/plugins/official/:instanceId/history-import',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request);
      if ('error' in access) return pluginAccessError(reply, access);
      try {
        const body = requireHistoryImportBody(request.body);
        const target = await resolveHistoryImportTarget(options, request.params.instanceId);
        assertCurrentHistoryImportAuthority(target, body.expectedRevision);
        await assertOwnerAuthConnected(options.auth, target);
        return await target.historyImport.importMinute({
          entry: target.entry,
          instance: target.instance,
          expectedRevision: body.expectedRevision,
          reference: body.reference,
        });
      } catch (error) {
        return sendHistoryImportError(reply, error);
      }
    },
  );
}
