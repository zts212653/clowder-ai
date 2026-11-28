import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getRegisteredAcpConfig } from '../config/cat-config-loader.js';
import { getResolvedCats } from '../config/resolved-cats.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveDshDesktopHome } from '../utils/dsh-desktop-launch.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';
import type { registerAgentAccessRoutes } from './agent-access-routes.js';
import { type DshDesktopSource, prepareDshDesktopSetup, readDshDesktopSetup } from './dsh-desktop-setup.js';
import { type DshSetupLaunch, resolveDshSetupLaunch } from './dsh-setup-launch.js';
import {
  type PreparedDshSetup,
  prepareDshSetup,
  type RunDshConnection,
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
      .max(80)
      .optional(),
  })
  .strict();
const prepare = selection
  .extend({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(512),
    memberId: z.string().min(1).max(160).optional(),
  })
  .strict();
const preferences = z.object({
  model: z.string().min(1).max(512).optional(),
  effort: z.string().min(1).max(160).optional(),
});
const test = preferences.extend({ id: z.string().uuid() }).strict();
type DshSetupRequest = { request: FastifyRequest; reply: FastifyReply; operator: string };

interface DshSetupRouteOptions {
  resolveLaunch?: (id: string) => DshSetupLaunch | Promise<DshSetupLaunch>;
  resolveDesktopLaunch?: (id: string) => DshDesktopSource | Promise<DshDesktopSource>;
  audit?: (target: string, owner: string) => Promise<unknown>;
  runConnection?: RunDshConnection;
  isAvailable?: () => Promise<boolean>;
  readDetection?: ReturnType<typeof registerAgentAccessRoutes>['readDetection'];
  readDshAdapterDesktop?: ReturnType<typeof registerAgentAccessRoutes>['readDshAdapterDesktop'];
}
export function registerDshSetupRoutes(app: FastifyInstance, options: DshSetupRouteOptions = {}) {
  async function runtimeFor(id: string, root: string, context: DshSetupRequest) {
    if (!options.readDetection) return (await discoverNativeRuntimes(root)).runtimes.find((item) => item.id === id);
    const detected = await options.readDetection(context.request, context.reply, context.operator, {});
    if (detected.readiness.state !== 'ready') throw Error('dsh_setup_unavailable');
    return detected.candidates.find((item) => item.id === id);
  }
  const resolveLaunch =
    options.resolveLaunch ??
    (async (id: string, context: DshSetupRequest) => {
      const root = resolveActiveProjectRoot();
      const runtime = await runtimeFor(id, root, context);
      if (!runtime?.installed || !('acp' in runtime) || !runtime.acp || runtime.acp.transport === 'httpstream')
        throw Error('dsh_setup_custom_startup');
      return resolveDshSetupLaunch(runtime.acp.command, runtime.acp.startupArgs, root);
    });
  const resolveDesktop = async (id: string, context: DshSetupRequest): Promise<DshDesktopSource> => {
    const adapter = id.startsWith('plugin:');
    if (!adapter && options.resolveDesktopLaunch) return options.resolveDesktopLaunch(id);
    const cwd = resolveActiveProjectRoot();
    const runtime = adapter
      ? await options.readDshAdapterDesktop?.(context.request, context.reply, id)
      : await runtimeFor(id, cwd, context);
    if (!runtime?.installed || !('dshDesktop' in runtime) || !runtime.dshDesktop || !runtime.command)
      throw Error('dsh_setup_custom_startup');
    if (options.resolveDesktopLaunch) {
      const source = await options.resolveDesktopLaunch(id);
      if (source.command !== runtime.command) throw Error('dsh_setup_custom_startup');
      return source;
    }
    return { command: runtime.command, cwd, ...(await resolveDshDesktopHome(runtime.command)) };
  };
  const audit =
    options.audit ??
    ((target: string, owner: string) =>
      getEventAuditLog().append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: { target, operator: owner },
      }));
  const receipts = new Map<string, { owner: string; at: number; value: PreparedDshSetup }>();
  let busy = false;
  function route<T>(
    action: string,
    schema: z.ZodType<T>,
    handler: (data: T, context: DshSetupRequest) => Promise<unknown>,
  ) {
    app.post(`/api/cats/dsh-setup/${action}`, async (request, reply) => {
      if (!isDirectLoopbackRequest(request)) return reply.code(403).send({ error: 'dsh_setup_local_only' });
      const owner = requirePrivilegedRouteOwner(request, reply, { surface: 'DSH setup' });
      if (!owner.ok) return owner.response;
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'dsh_setup_invalid_request' });
      if (busy) return reply.code(409).send({ error: 'dsh_setup_busy' });
      busy = true;
      try {
        if (options.isAvailable && !(await options.isAvailable())) throw Error('dsh_setup_unavailable');
        for (const [id, receipt] of receipts) if (Date.now() - receipt.at > 10 * 60_000) receipts.delete(id);
        return await handler(parsed.data, { request, reply, operator: owner.userId });
      } catch (error) {
        const code =
          error instanceof Error && /^dsh_[a-z_]+$/.test(error.message) ? error.message : 'dsh_setup_unavailable';
        // Raw DSH errors, dumps, URLs and credential names never leave this boundary.
        return reply.code(code === 'dsh_setup_changed' ? 409 : 422).send({ error: code });
      } finally {
        busy = false;
      }
    });
  }
  route('inspect', selection, async (data, context) =>
    data.sourceProfile === undefined
      ? (await readDshDesktopSetup(await resolveDesktop(data.runtimeId, context))).view
      : (await readDshSetup(await resolveLaunch(data.runtimeId, context), data.sourceProfile)).view,
  );
  route('prepare', prepare, async (input, context) => {
    await audit('dsh-acp-preparation', context.operator);
    const desktop = input.sourceProfile === undefined ? await resolveDesktop(input.runtimeId, context) : undefined;
    const root = desktop?.cwd ?? resolveActiveProjectRoot();
    const existing = input.memberId ? getResolvedCats(root)[input.memberId] : undefined;
    const existingAcp = input.memberId ? getRegisteredAcpConfig(input.memberId, root) : undefined;
    if (input.memberId && (!existing || !desktop || existingAcp?.command !== desktop.command))
      throw Error('dsh_setup_changed');
    const value =
      input.sourceProfile === undefined
        ? await prepareDshDesktopSetup(desktop!, input.revision, input.provider, input.model, existing?.env?.DSH_HOME)
        : await prepareDshSetup(
            await resolveLaunch(input.runtimeId, context),
            input.sourceProfile,
            input.revision,
            input.provider,
            input.model,
          );
    const oldest = receipts.keys().next().value;
    if (receipts.size >= 64 && oldest) receipts.delete(oldest);
    receipts.set(value.id, { owner: context.operator, at: Date.now(), value });
    return {
      id: value.id,
      command: value.launch.command,
      startupArgs: value.launch.args,
      ...('env' in value.launch ? { env: value.launch.env } : {}),
      provider: value.provider,
      model: value.model,
    };
  });
  route('test', test, async (data, { operator: owner }) => {
    const receipt = receipts.get(data.id);
    if (!receipt || receipt.owner !== owner) throw Error('dsh_setup_expired');
    await audit('dsh-acp-connection-test', owner);
    await testDshSetup(receipt.value, { model: data.model, effort: data.effort }, options.runConnection);
    return { ok: true };
  });
}
