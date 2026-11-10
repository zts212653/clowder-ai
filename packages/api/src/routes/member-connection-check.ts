import { createHash } from 'node:crypto';
import type { DshConnectionCheckFact, DshConnectionCheckView } from '@cat-cafe/shared';
import { isDshLauncher } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type InvocationPluginMcpView,
  withInvocationPluginMcpView,
} from '../config/capabilities/invocation-plugin-mcp-view.js';
import { RedisDshMemberConnectionCheckStore } from '../domains/cats/services/stores/redis/RedisDshMemberConnectionCheckStore.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';

interface DshConnectionTarget {
  configurationRevision: string;
  effectiveFingerprint: string;
  toolManifestHash: string;
  run: () => Promise<{ outcome: 'passed' | 'partial' | 'failed' | 'unknown'; reasonCode?: string }>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function failureReason(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/Invalid schema for function|is not a "regex"/i.test(message)) return 'tool_schema_rejected';
  if (/dsh_desktop_auth_read_only|Credential store modify failed/.test(message))
    return 'dsh_setup_auth_refresh_required';
  return /^dsh_[a-z_]+$/.test(message) ? message : 'check_result_unknown';
}

async function resolveDshConnectionTarget(catId: string, root: string, owner: string): Promise<DshConnectionTarget> {
  const [
    { getResolvedCats },
    { getRegisteredAcpConfig },
    { resolveMemberEnvironment },
    { memberConfigurationRevision },
    { captureAcpMcpSources },
    { materializeSessionMcpServers },
    { readDshCheckBinding, createDshCheckLaunch },
    { readDshDesktopSetup },
    { readDshToolManifest, dshDefinitionOnlyServers },
  ] = await Promise.all([
    import('../config/resolved-cats.js'),
    import('../config/cat-config-loader.js'),
    import('../config/member-environment.js'),
    import('../config/member-config-revision.js'),
    import('../domains/cats/services/agents/providers/acp/configuration/acp-mcp-source.js'),
    import('../domains/cats/services/agents/providers/acp/acp-session-env.js'),
    import('./dsh-check-launch.js'),
    import('./dsh-desktop-setup.js'),
    import('./dsh-tool-manifest.js'),
  ]);
  const config = getResolvedCats(root)[catId];
  const acp = getRegisteredAcpConfig(catId, root);
  if (!config || !acp || acp.transport === 'httpstream' || !isDshLauncher(acp.command, acp.startupArgs))
    throw Error('dsh_setup_custom_startup');
  const binding = readDshCheckBinding({
    command: acp.command,
    args: acp.startupArgs,
    cwd: root,
    env: resolveMemberEnvironment(config.env),
  });
  const source = await readDshDesktopSetup(binding.source);
  const servers = await captureAcpMcpSources({
    projectRoot: root,
    userProjectRoot: root,
    catId,
    mcpSupport: config.mcpSupport !== false,
    mcpWhitelist: acp.mcpWhitelist ?? [],
  });
  // Binding removes inherited invocation credentials. A check never borrows the
  // current author's turn or gains a business tools/call forwarding path.
  const admitted = materializeSessionMcpServers(servers, { CAT_CAFE_USER_ID: owner, CAT_CAFE_CAT_ID: catId });
  const manifest = await readDshToolManifest(admitted, root);
  const effort = config.cli?.effort?.trim() || undefined;
  const model = config.defaultModel || JSON.stringify([binding.route.provider, binding.route.model]);
  const configurationRevision = memberConfigurationRevision(root, catId);
  if (!configurationRevision) throw Error('dsh_setup_changed');
  return {
    configurationRevision,
    effectiveFingerprint: digest([binding.launch, binding.patchText, model, effort, source.state.revision]),
    toolManifestHash: manifest.hash,
    run: async () => {
      const [
        { AcpClient, AcpProtocolError },
        { applySessionConfiguration },
        { prepareDshSecretPatch },
        { dshSetupBootstrap },
      ] = await Promise.all([
        import('../domains/cats/services/agents/providers/acp/AcpClient.js'),
        import('../domains/cats/services/agents/providers/acp/session-configuration.js'),
        import('../domains/cats/services/agents/providers/dsh-secret-patch.js'),
        import('./dsh-setup-launch.js'),
      ]);
      const isolated = createDshCheckLaunch(binding);
      let client: InstanceType<typeof AcpClient> | undefined;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        void client?.close();
      }, 60_000);
      try {
        const args = await prepareDshSecretPatch(
          isolated.launch.command,
          isolated.launch.args,
          isolated.launch.cwd,
          model,
        );
        const launch = dshSetupBootstrap({ ...isolated.launch, args });
        client = new AcpClient({
          command: launch.command,
          args: launch.args,
          cwd: launch.verifyCwd(),
          env: isolated.launch.env,
          ...(process.platform === 'win32' ? { verifyBootstrapCwd: launch.verifyCwd } : {}),
          permissionHandler: (_request, respond) => respond({ cancelled: true }),
        });
        await client.initialize();
        const session = await client.newSession(launch.cwd, dshDefinitionOnlyServers(manifest, isolated.directory));
        try {
          await applySessionConfiguration(client, session, { model, ...(effort ? { effort } : {}) });
        } catch {
          return { outcome: 'failed', reasonCode: 'session_configuration_unavailable' };
        }
        const result = await client.promptCollect(
          session.sessionId,
          'Connection check. Reply DSH_CONNECTION_OK as text without calling tools.',
          { timeoutMs: 60_000 },
        );
        const text = result.events
          .flatMap(({ update }) => {
            const content = update.content;
            return update.sessionUpdate === 'agent_message_chunk' &&
              content &&
              !Array.isArray(content) &&
              content.type === 'text'
              ? [content.text]
              : [];
          })
          .join('');
        return result.stopReason === 'end_turn' && text.trim()
          ? { outcome: 'passed' }
          : { outcome: 'partial', reasonCode: 'model_reply_unconfirmed' };
      } catch (error) {
        if (timedOut) return { outcome: 'unknown', reasonCode: 'check_timed_out' };
        const detail = error instanceof AcpProtocolError ? new Error(JSON.stringify(error.data)) : error;
        return { outcome: 'failed', reasonCode: failureReason(detail) };
      } finally {
        clearTimeout(deadline);
        await client?.close();
        isolated.close();
      }
    },
  };
}

/** Persistence is optional infrastructure, never a reason to undo member saving. */
export function registerDshMemberConnectionChecks(
  app: FastifyInstance,
  options: {
    redis?: RedisClient;
    store?: RedisDshMemberConnectionCheckStore;
    resolvePluginMcpView?: () => Promise<InvocationPluginMcpView | undefined>;
    resolveTarget?: (catId: string, root: string, owner: string) => Promise<DshConnectionTarget>;
  } = {},
) {
  const store = options.store ?? (options.redis ? new RedisDshMemberConnectionCheckStore(options.redis) : undefined);
  const resolveTarget = async (catId: string, root: string, owner: string) => {
    const view = await options.resolvePluginMcpView?.();
    const target = await withInvocationPluginMcpView(
      () => (options.resolveTarget ?? resolveDshConnectionTarget)(catId, root, owner),
      view,
      { kind: 'member', projectRoot: root, memberCatId: catId },
    );
    if (view?.isCurrent?.() === false) throw Error('dsh_setup_changed');
    return target;
  };
  const active = new Map<string, { attemptId: string; promise: Promise<DshConnectionCheckView> }>();
  const activityKey = (scope: string, target: Pick<DshConnectionTarget, 'effectiveFingerprint' | 'toolManifestHash'>) =>
    JSON.stringify([scope, target.effectiveFingerprint, target.toolManifestHash]);
  const body = z
    .object({ attemptId: z.string().uuid(), expectedRevision: z.string().min(1).max(160).optional() })
    .strict();
  const current = (
    scope: string,
    fact: DshConnectionCheckFact | null,
    target: DshConnectionTarget,
  ): DshConnectionCheckView => {
    if (!fact) return { state: 'unchecked' };
    if (fact.effectiveFingerprint !== target.effectiveFingerprint || fact.toolManifestHash !== target.toolManifestHash)
      return { state: 'stale', fact, reasonCode: 'check_configuration_changed' };
    if (fact.phase === 'started')
      return {
        state: active.get(activityKey(scope, fact))?.attemptId === fact.attemptId ? 'checking' : 'unknown',
        fact,
        reasonCode: 'check_result_unknown',
      };
    return { state: fact.outcome ?? 'unknown', fact, ...(fact.reasonCode ? { reasonCode: fact.reasonCode } : {}) };
  };
  app.route<{ Params: { id: string } }>({
    method: ['GET', 'POST'],
    url: '/api/cats/:id/connection-check',
    handler: async (request, reply) => {
      if (!isDirectLoopbackRequest(request)) return reply.code(403).send({ error: 'dsh_setup_local_only' });
      const identity = requirePrivilegedRouteOwner(request, reply, { surface: 'DSH connection check' });
      if (!identity.ok) return identity.response;
      const input = request.method === 'POST' ? body.safeParse(request.body) : undefined;
      if (input && !input.success) return reply.code(400).send({ error: 'dsh_setup_invalid_request' });
      if (!store) return { state: 'unknown', reasonCode: 'check_store_unavailable' } satisfies DshConnectionCheckView;
      const root = resolveActiveProjectRoot(),
        catId = request.params.id;
      const scope = digest([identity.userId, root, catId]);
      try {
        const target = await resolveTarget(catId, root, identity.userId);
        if (!input?.success) return current(scope, await store.latest(scope), target);
        if (input.data.expectedRevision && input.data.expectedRevision !== target.configurationRevision)
          return reply.code(409).send({ state: 'stale', reasonCode: 'dsh_setup_changed' });
        const previous = await store.attempt(scope, input.data.attemptId);
        if (previous) {
          const live = active.get(activityKey(scope, previous));
          return live?.attemptId === previous.attemptId ? live.promise : current(scope, previous, target);
        }
        const key = activityKey(scope, target);
        const running = active.get(key);
        if (running) return running.promise;
        const fact: DshConnectionCheckFact = {
          catId,
          attemptId: input.data.attemptId,
          effectiveFingerprint: target.effectiveFingerprint,
          toolManifestHash: target.toolManifestHash,
          phase: 'started',
          startedAt: Date.now(),
        };
        const promise = (async (): Promise<DshConnectionCheckView> => {
          if (!(await store.start(scope, fact)))
            return current(scope, await store.attempt(scope, fact.attemptId), target);
          const result = await target
            .run()
            .catch((error) => ({ outcome: 'failed' as const, reasonCode: failureReason(error) }));
          const finished = { ...fact, phase: 'terminal' as const, ...result, finishedAt: Date.now() };
          await store.finish(scope, finished);
          return current(scope, finished, target);
        })();
        active.set(key, { attemptId: fact.attemptId, promise });
        try {
          return await promise;
        } finally {
          active.delete(key);
        }
      } catch (error) {
        return { state: 'unknown', reasonCode: failureReason(error) } satisfies DshConnectionCheckView;
      }
    },
  });
}
