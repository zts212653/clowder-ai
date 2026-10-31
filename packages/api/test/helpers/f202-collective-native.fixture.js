import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createModuleHostInvocation } from '../../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { NativePluginActions } from '../../src/domains/plugin/declared/native-plugin-actions.js';
import { createPluginMessagingHost } from '../../src/domains/plugin/host-surface/plugin-messaging-host.js';
import { pluginNativeActionRoutes } from '../../src/routes/plugin-native-action-routes.js';
import { collectivePackageRoot, loadCollectiveModule } from './f202-collective-installed-business.js';

/** Real package handlers behind Host native auth, source projection and module invocation.
 * Only the already authenticated local thread/session and running Cat are fixtures.
 */
export async function installCollectiveNativeFixture({ app, f, registry, messages, instanceId, message, auth }) {
  const manifest = parse(await readFile(join(collectivePackageRoot, 'plugin.yaml'), 'utf8'));
  const [
    { createCollectivePublicSourceCaller },
    { createCollectivePublicNativeActions },
    { openCollectiveContextReferences },
    native,
  ] = await Promise.all([
    loadCollectiveModule('collective-public-source.js'),
    loadCollectiveModule('collective-public-native-context.js'),
    loadCollectiveModule('collective-context-refs.js'),
    loadCollectiveModule('public-native-methods.js'),
  ]);
  const threads = { get: async () => ({ id: message.threadId, createdBy: message.userId }) };
  const messaging = createPluginMessagingHost({
    pluginId: manifest.pluginId,
    pluginInstanceId: instanceId,
    ownerUserId: message.userId,
    manifest,
    messageStore: messages,
    threadStore: threads,
    messaging: {},
  });
  const sourceCaller = createCollectivePublicSourceCaller({
    connector: f.connector,
    pluginInstanceId: instanceId,
    native: { contributionId: native.COLLECTIVE_NATIVE_ID, methods: native.COLLECTIVE_PUBLIC_METHODS },
    messaging,
    threads: { ...threads, getCats: async () => ({ participants: [{ catId: 'codex-sol' }] }) },
  });
  const references = await openCollectiveContextReferences(join(f.root, 'native-context'), () => {});
  const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller, references });
  const admission = {
    instance: {
      pluginInstanceId: instanceId,
      pluginId: manifest.pluginId,
      packageDigest: 'verified-fixture',
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: { manifest },
  };
  const carrier = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const nativeActions = new NativePluginActions(async () => admission);
  nativeActions.activate(admission, 0, (method, input) => carrier.invoke(instanceId, method, input));
  await app.register(pluginNativeActionRoutes, {
    actions: nativeActions,
    registry,
    threadStore: threads,
    sources: {
      messageStore: messages,
      invocationTracker: {
        getActiveSlots: () => [
          {
            catId: 'codex-sol',
            activeRun: {
              invocationId: auth.invocationId,
              threadId: message.threadId,
              targetId: 'codex-sol',
              inputMessageIds: [message.id],
            },
          },
        ],
      },
    },
  });
  return nativeActions.environment(instanceId, native.COLLECTIVE_NATIVE_ID).CLOWDER_PLUGIN_ACTION_TOKEN;
}
