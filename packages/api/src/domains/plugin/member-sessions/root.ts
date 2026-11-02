import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { getCatModel } from '../../../config/cat-models.js';
import { freezeExecutionWorkspace } from '../../cats/services/agents/invocation/execution-workspace.js';
import type { InvocationDeps } from '../../cats/services/agents/invocation/invoke-single-cat.js';
import { CodexAgentService } from '../../cats/services/agents/providers/CodexAgentService.js';
import type { AgentRegistry } from '../../cats/services/agents/registry/AgentRegistry.js';
import type { FileProfileRepository } from '../../cats/services/profile/ProfileRepository.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import { RedisPluginPrivateStorage } from '../host-surface/plugin-private-storage.js';
import type { DormantPluginRuntimeComposition } from '../runtime-composition.js';
import { createMemberSessionHost } from './host.js';
import { createMemberSessionMessaging } from './messaging.js';
import { createMemberProfileMemory } from './profile-memory.js';
import { createMemberResourceDescription } from './resources.js';
import { createMemberSessionRouter } from './router.js';
import { createMemberRuntime } from './runtime.js';
import { createPluginMemberSessions } from './service.js';
import { MemberSessionStore } from './store.js';
import type { MemberSessionScope } from './types.js';
import { digest } from './validation.js';

/** Production composition of existing account, Queue, profile and plugin ports.
 * No world/game rules or provider credentials cross the module surface. */
export function createRootMemberSessions(deps: {
  readonly redis: RedisClient;
  readonly ownerUserId: string;
  readonly projectRoot: string;
  readonly agents: AgentRegistry;
  readonly threads: IThreadStore;
  readonly messages: IMessageStore;
  readonly turns: ITurnExecutionStore;
  readonly profiles: FileProfileRepository;
  pluginRuntime(): DormantPluginRuntimeComposition;
  invocationDeps(): InvocationDeps;
}) {
  const storage = new RedisPluginPrivateStorage(deps.redis, 'host-member-sessions:v1');
  const installed = async (scope: MemberSessionScope) => {
    await scope.assertCurrent();
    if (scope.ownerUserId !== deps.ownerUserId) throw new Error('member_session_owner_mismatch');
    const snapshot = await deps.pluginRuntime().inventoryStore.snapshot();
    const instance = snapshot.instances.find((i) => i.pluginInstanceId === scope.pluginInstanceId);
    const pkg = snapshot.packages.find((p) => p.packageDigest === scope.packageDigest);
    if (
      !instance ||
      instance.packageDigest !== scope.packageDigest ||
      instance.lifecycleState !== 'installed' ||
      instance.activationState !== 'enabled' ||
      instance.configReadiness !== 'ready' ||
      pkg?.packageState !== 'installed' ||
      !pkg.manifest
    )
      throw new Error('member_session_installation_unavailable');
    await scope.assertCurrent();
    return { instance, pkg, manifest: pkg.manifest };
  };
  const profiles = createMemberProfileMemory(deps.profiles);
  const runtimeServices = {
    config(catId: string) {
      const cat = catRegistry.tryGet(createCatId(catId));
      if (!cat || !deps.agents.has(catId)) throw new Error('member_target_unavailable');
      return { ...cat.config, defaultModel: getCatModel(catId) };
    },
    service(catId: string, config: import('@cat-cafe/shared').CatConfig) {
      if (!deps.agents.has(catId)) throw new Error('member_target_unavailable');
      return config.clientId === 'openai'
        ? new CodexAgentService({ catId: createCatId(catId), model: config.defaultModel, carrierMode: 'exec_json' })
        : deps.agents.get(catId);
    },
  };
  const runtime = createMemberRuntime({
    ...runtimeServices,
    workspace: (input, scope, config) =>
      freezeExecutionWorkspace({
        threadStore: deps.threads,
        threadId: input.threadId,
        userId: scope.ownerUserId,
        provider: config.clientId,
      }),
  });
  const messaging = createMemberSessionMessaging(async (scope) => {
    const { instance, manifest } = await installed(scope);
    return {
      pluginId: instance.pluginId,
      pluginInstanceId: scope.pluginInstanceId,
      ownerUserId: scope.ownerUserId,
      manifest,
      threadStore: deps.threads,
      messageStore: deps.messages,
      messaging: deps.pluginRuntime().messaging,
    };
  });
  const sessions = createPluginMemberSessions({
    storage,
    canonicalExecution: { turns: deps.turns, messages: deps.messages },
    messaging,
    resolveMemory: profiles.resolve,
    resolveRuntime: runtime.snapshot,
    describeResources: async (catId, scope) => {
      await installed(scope);
      return createMemberResourceDescription({
        ...runtimeServices,
        projectRoot: deps.projectRoot,
        async memory(catId, scope) {
          const refs = await profiles.list({ ...scope, catId });
          return Promise.all(
            refs.map(async (ref) => {
              const snapshot = await profiles.resolve(ref, { ...scope, catId });
              return { ...ref, bytes: Buffer.byteLength(snapshot.text) };
            }),
          );
        },
      })(catId, scope);
    },
    threadCreation: {
      store: deps.threads,
      async workspace(scope, catId) {
        await installed(scope);
        const path = join(
          deps.projectRoot,
          '.cat-cafe',
          'member-workspaces',
          digest([scope.ownerUserId, scope.pluginInstanceId, catId]),
        );
        await mkdir(path, { recursive: true, mode: 0o700 });
        await scope.assertCurrent();
        return path;
      },
    },
    async assertInstallation(scope, contributionId) {
      const { manifest } = await installed(scope);
      if (manifest.contributions?.filter((c) => c.type === 'mcp' && c.id === contributionId).length !== 1)
        throw new Error('member_native_contribution_unavailable');
      await deps.pluginRuntime().supervisor.resolveNativeMcpLaunch({
        mode: 'plugin_native',
        pluginInstanceId: scope.pluginInstanceId,
        contributionId,
      });
      await scope.assertCurrent();
    },
    async assertThread(ownerUserId, threadId, catId) {
      const thread = await deps.threads.get(threadId);
      if (
        !thread ||
        thread.deletedAt ||
        thread.createdBy !== ownerUserId ||
        !thread.participants.includes(createCatId(catId))
      )
        throw new Error('member_session_thread_unavailable');
    },
  });
  const host = createMemberSessionHost(sessions);
  return {
    forInstance: host.forInstance,
    assertCallback: host.assertCallback,
    profileReferences: profiles.list,
    routing: createMemberSessionRouter({
      sessions,
      store: new MemberSessionStore(storage),
      messaging,
      memory: profiles.resolve,
      acquire: runtime.acquire,
      executionScope: host.executionScope,
      executionSignal: host.executionSignal,
      registerCallback: host.registerCallback,
      finishExecution: host.finishExecution,
      invocationDeps: deps.invocationDeps,
      native: (policy) => deps.pluginRuntime().supervisor.resolveNativeMcpLaunch(policy),
    }),
  };
}
