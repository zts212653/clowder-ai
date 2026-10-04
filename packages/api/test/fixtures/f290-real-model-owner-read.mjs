import { NEEDS_ME_PRODUCER_IDS } from '@cat-cafe/shared';
import { EntrustedWorkOwnerReadService } from '../../src/domains/growing/EntrustedWorkOwnerReadService.ts';
import { F232PreparedArtifactReader } from '../../src/domains/growing/F232PreparedArtifactReader.ts';
import { F290CollectiveWorkResultProducerAdapter } from '../../src/domains/growing/F290CollectiveWorkResultProducerAdapter.ts';
import { NeedsMeProducerCatalog } from '../../src/domains/growing/NeedsMeProducerCatalog.ts';
import { registerEntrustedWorkReadRoutes } from '../../src/routes/entrusted-work-read-routes.ts';

/** Canonical index.ts owner-read composition; unrelated producer domains have no fixture work. */
export async function registerModelOwnerRead(app, registry, cafe, tasks, messages, evidence) {
  const artifacts = new F232PreparedArtifactReader({ messages });
  const collectiveProducer = new F290CollectiveWorkResultProducerAdapter({
    connector: () => cafe.connector,
    tasks,
    messages,
    artifacts,
  });
  const absentProducers = NEEDS_ME_PRODUCER_IDS.filter((id) => id !== collectiveProducer.producerId);
  const catalog = new NeedsMeProducerCatalog([
    collectiveProducer,
    ...absentProducers.map((producerId) => ({
      producerId,
      async listCurrentReceipts() {
        return [];
      },
      async readCurrentReceipt() {
        return null;
      },
      async reEvaluate() {
        throw new Error('Unrelated Needs Me producer is not composed in this fixture');
      },
    })),
  ]);
  const service = new EntrustedWorkOwnerReadService({ tasks, producerCatalog: catalog, artifactReader: artifacts });
  await app.register(async (scope) => {
    registerEntrustedWorkReadRoutes(scope, { service, callbackRegistry: registry });
  });
  evidence.ownerReadCompositions ??= [];
  evidence.ownerReadCompositions.push({
    cafe: cafe.label,
    service: 'production EntrustedWorkOwnerReadService and authenticated canonical routes',
    collectiveProducer: 'production F290CollectiveWorkResultProducerAdapter',
    absentProducerFixtureBindings: absentProducers,
  });
}
