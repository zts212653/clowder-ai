import {
  type CatCatalogSubscriberHandle,
  type CatCatalogSubscriberOpts,
  createCatCatalogSubscriber,
} from '../../../../../config/cat-catalog-subscriber.js';
import { CloudConversationHostRegistry } from '../../../../plugin/declared/cloud-conversation-host-registry.js';
import {
  createDormantPluginRuntimeComposition,
  type DormantPluginRuntimeCompositionOptions,
} from '../../../../plugin/runtime-composition.js';
import { PluginConversationHostAdapter } from './plugin-conversation-host-adapter.js';
import { PluginConversationReturnPoller } from './plugin-conversation-return-poller.js';

type PollerOptions = ConstructorParameters<typeof PluginConversationReturnPoller>[0];

/** Production ownership boundary: the adapter, poller and runtime cannot select different registries. */
export function createCloudConversationComposition(
  options: Omit<PollerOptions, 'registry' | 'provider'> & {
    reconcileCats: () => Promise<void>;
    catalogLog: CatCatalogSubscriberOpts['log'];
  },
) {
  const registry = new CloudConversationHostRegistry();
  const adapter = new PluginConversationHostAdapter({ registry, provider: 'chatgpt' });
  const poller = new PluginConversationReturnPoller({ ...options, registry, provider: 'chatgpt' });
  let subscriber: CatCatalogSubscriberHandle | undefined;
  return {
    adapter,
    createRuntime(runtimeOptions: Omit<DormantPluginRuntimeCompositionOptions, 'cloudConversationHosts'>) {
      return createDormantPluginRuntimeComposition({ ...runtimeOptions, cloudConversationHosts: registry });
    },
    start() {
      if (subscriber) return;
      subscriber = createCatCatalogSubscriber({
        log: options.catalogLog,
        async onReconcile() {
          await options.reconcileCats();
          poller.reevaluate();
        },
      });
      poller.start();
    },
    stop() {
      subscriber?.unsubscribe();
      subscriber = undefined;
      poller.stop();
    },
  };
}
