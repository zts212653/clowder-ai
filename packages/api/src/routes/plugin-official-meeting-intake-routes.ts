import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ExternalPluginLifecycleService } from '../domains/plugin/external-plugin-lifecycle.js';
import { PluginLifecycleError } from '../domains/plugin/external-plugin-lifecycle-types.js';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginInstanceRecord, PluginInventorySnapshot } from '../domains/plugin/host-inventory/types.js';
import type { OfficialPluginCatalogEntry } from '../domains/plugin/official-catalog.js';
import type { OfficialPluginAuthPort } from '../domains/plugin/official-plugin-auth.js';
import {
  OfficialMeetingIntakeError,
  type OfficialPluginMeetingIntakePort,
} from '../domains/plugin/official-plugin-meeting-intake-port.js';
import { pluginAccessError, requirePluginWriteAccess } from './plugin-access-guards.js';

interface ResolvedOfficialInstance {
  readonly entry: OfficialPluginCatalogEntry;
  readonly instance: PluginInstanceRecord;
}

interface MeetingIntakeRouteOptions {
  readonly inventory: PluginInventoryStore;
  readonly lifecycle: Pick<ExternalPluginLifecycleService, 'enable' | 'runWithRuntimeSuspended'>;
  readonly auth?: OfficialPluginAuthPort;
  readonly meetingIntake: OfficialPluginMeetingIntakePort;
  readonly resolve: (instanceId: string) => Promise<ResolvedOfficialInstance | undefined>;
  readonly project: (
    entry: OfficialPluginCatalogEntry,
    snapshot: PluginInventorySnapshot,
    instance: PluginInstanceRecord,
  ) => Promise<unknown>;
}

interface PreviewRequest {
  readonly Params: { instanceId: string };
  readonly Body: { expectedRevision?: unknown };
}

interface ResolveRequest {
  readonly Params: { instanceId: string };
  readonly Body: {
    expectedRevision?: unknown;
    fingerprint?: unknown;
    action?: unknown;
    resume?: unknown;
  };
}

function expectedRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function mutationError(reply: FastifyReply, error: unknown) {
  if (error instanceof PluginLifecycleError) {
    const status = error.code === 'INSTANCE_NOT_FOUND' || error.code === 'STALE_INSTANCE' ? 404 : 409;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof OfficialMeetingIntakeError) {
    return reply.status(409).send({ error: error.message, code: error.code });
  }
  return reply.status(502).send({
    error: 'Unable to inspect or recover the Feishu meeting intake window',
    code: 'CATCH_UP_FAILED',
  });
}

function requireCurrentRecoveryPackage(reply: FastifyReply, resolved: ResolvedOfficialInstance): boolean {
  if (resolved.instance.packageDigest === resolved.entry.packageDigest) return true;
  reply.status(409).send({
    error: 'Update the official Feishu plugin before inspecting or resolving its catch-up window',
    code: 'UPDATE_REQUIRED',
  });
  return false;
}

async function requireConnectedAuth(
  reply: FastifyReply,
  auth: OfficialPluginAuthPort | undefined,
  resolved: ResolvedOfficialInstance,
) {
  if (!resolved.entry.ownerAuth) return true;
  if (!auth) {
    reply.status(503).send({ error: 'Official plugin authentication is unavailable', code: 'AUTH_UNAVAILABLE' });
    return false;
  }
  if ((await auth.status(resolved)).status !== 'connected') {
    reply.status(409).send({
      error: 'Connect the owner Feishu account before inspecting or enabling meeting intake',
      code: 'AUTH_REQUIRED',
    });
    return false;
  }
  return true;
}

export function registerOfficialPluginMeetingIntakeRoutes(
  app: FastifyInstance,
  options: MeetingIntakeRouteOptions,
): void {
  app.post<PreviewRequest>('/api/plugins/official/:instanceId/catch-up/preview', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const revision = expectedRevision(request.body?.expectedRevision);
    if (!revision) return reply.status(400).send({ error: 'expectedRevision must be a positive integer' });
    const resolved = await options.resolve(request.params.instanceId);
    if (!resolved) return reply.status(404).send({ error: 'Official plugin instance not found' });
    if (!requireCurrentRecoveryPackage(reply, resolved)) return;
    if (!(await requireConnectedAuth(reply, options.auth, resolved))) return;
    try {
      const maintenance = await options.lifecycle.runWithRuntimeSuspended({
        instanceId: resolved.instance.pluginInstanceId,
        expectedRevision: revision,
        stopReason: 'meeting_catch_up',
        resumeFailureCode: 'CATCH_UP_RESUME_FAILED',
        operation: (stopped) => options.meetingIntake.preview(resolved.entry, stopped),
      });
      return {
        plugin: await options.project(resolved.entry, await options.inventory.snapshot(), maintenance.instance),
        preview: maintenance.result,
      };
    } catch (error) {
      return mutationError(reply, error);
    }
  });

  app.post<ResolveRequest>('/api/plugins/official/:instanceId/catch-up/resolve', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const revision = expectedRevision(request.body?.expectedRevision);
    const fingerprint = request.body?.fingerprint;
    const action = request.body?.action;
    const resume = request.body?.resume;
    if (
      !revision ||
      typeof fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      (action !== 'future-only' && action !== 'replay') ||
      typeof resume !== 'boolean'
    ) {
      return reply
        .status(400)
        .send({ error: 'a valid revision, preview fingerprint, action, and resume are required' });
    }
    const resolved = await options.resolve(request.params.instanceId);
    if (!resolved) return reply.status(404).send({ error: 'Official plugin instance not found' });
    if (!requireCurrentRecoveryPackage(reply, resolved)) return;
    const willResume = resume || resolved.instance.activationState === 'enabled';
    if (willResume && !(await requireConnectedAuth(reply, options.auth, resolved))) return;
    try {
      const maintenance = await options.lifecycle.runWithRuntimeSuspended({
        instanceId: resolved.instance.pluginInstanceId,
        expectedRevision: revision,
        stopReason: 'meeting_catch_up',
        resumeFailureCode: 'CATCH_UP_RESUME_FAILED',
        operation: (stopped) => options.meetingIntake.resolve(resolved.entry, stopped, { action, fingerprint }),
      });
      const instance =
        resume &&
        (maintenance.instance.activationState === 'disabled' || maintenance.instance.activationState === 'error')
          ? await options.lifecycle.enable(
              maintenance.instance.pluginInstanceId,
              maintenance.instance.lifecycleRevision,
            )
          : maintenance.instance;
      return {
        plugin: await options.project(resolved.entry, await options.inventory.snapshot(), instance),
        resolution: maintenance.result,
      };
    } catch (error) {
      return mutationError(reply, error);
    }
  });
}
