import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';
import { type DshSetupLaunch, resolveDshSetupLaunch } from './dsh-setup-launch.js';
import {
  dshSourceProfiles,
  type PreparedDshSetup,
  prepareDshSetup,
  readDshSetup,
  testDshSetup,
} from './dsh-setup-service.js';
import { discoverNativeRuntimes } from './native-runtimes.js';

const selection = z
  .object({
    runtimeId: z.string().min(1).max(160),
    sourceProfile: z
      .string()
      .regex(/^[\w-]+$/)
      .max(80),
  })
  .strict();
const prepare = selection
  .extend({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(512),
  })
  .strict();
const test = z.object({ id: z.string().uuid() }).strict();

function launchFor(id: string) {
  const root = resolveActiveProjectRoot();
  const runtime = discoverNativeRuntimes(root).runtimes.find((item) => item.id === id);
  if (!runtime?.installed || !('acp' in runtime) || !runtime.acp || runtime.acp.transport === 'httpstream')
    throw Error('dsh_setup_custom_startup');
  return resolveDshSetupLaunch(runtime.acp.command, runtime.acp.startupArgs, root);
}

interface DshSetupRouteOptions {
  resolveLaunch?: (id: string) => DshSetupLaunch;
  audit?: (target: string, owner: string) => Promise<unknown>;
}
export function registerDshSetupRoutes(app: FastifyInstance, options: DshSetupRouteOptions = {}) {
  const resolveLaunch = options.resolveLaunch ?? launchFor;
  const audit =
    options.audit ??
    ((target: string, owner: string) =>
      getEventAuditLog().append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: { target, operator: owner },
      }));
  const receipts = new Map<string, { owner: string; at: number; value: PreparedDshSetup }>();
  let busy = false;
  function route<T>(action: string, schema: z.ZodType<T>, handler: (data: T, owner: string) => Promise<unknown>) {
    app.post(`/api/cats/dsh-setup/${action}`, async (request, reply) => {
      if (!isDirectLoopbackRequest(request)) return reply.code(403).send({ error: 'dsh_setup_local_only' });
      const owner = requirePrivilegedRouteOwner(request, reply, { surface: 'DSH setup' });
      if (!owner.ok) return owner.response;
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'dsh_setup_invalid_request' });
      if (busy) return reply.code(409).send({ error: 'dsh_setup_busy' });
      busy = true;
      try {
        for (const [id, receipt] of receipts) if (Date.now() - receipt.at > 10 * 60_000) receipts.delete(id);
        return await handler(parsed.data, owner.userId);
      } catch (error) {
        const code =
          error instanceof Error && /^dsh_[a-z_]+$/.test(error.message) ? error.message : 'dsh_setup_unavailable';
        // Raw DSH errors, dumps, URLs and credential names never leave this boundary.
        return reply
          .code(code === 'dsh_setup_changed' ? 409 : 422)
          .send({ error: code, profiles: dshSourceProfiles() });
      } finally {
        busy = false;
      }
    });
  }
  route(
    'inspect',
    selection,
    async (data) => (await readDshSetup(resolveLaunch(data.runtimeId), data.sourceProfile)).view,
  );
  route('prepare', prepare, async (input, owner) => {
    const launch = resolveLaunch(input.runtimeId);
    await audit('dsh-acp-preparation', owner);
    const value = await prepareDshSetup(launch, input.sourceProfile, input.revision, input.provider, input.model);
    const oldest = receipts.keys().next().value;
    if (receipts.size >= 64 && oldest) receipts.delete(oldest);
    receipts.set(value.id, { owner, at: Date.now(), value });
    return {
      id: value.id,
      command: value.launch.command,
      startupArgs: value.launch.args,
      provider: value.provider,
      model: value.model,
    };
  });
  route('test', test, async (data, owner) => {
    const receipt = receipts.get(data.id);
    if (!receipt || receipt.owner !== owner) throw Error('dsh_setup_expired');
    await audit('dsh-acp-connection-test', owner);
    await testDshSetup(receipt.value);
    return { ok: true };
  });
}
