import type { HumanAuthProvider } from '../human-auth-provider.js';
import { CollectiveServiceStore } from '../store.js';

export async function participationFixture(dataDirectory: string) {
  const humanAuthProvider: HumanAuthProvider = {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state }) => `https://github.test/authorize?state=${state}`,
    authenticate: async ({ code }) => ({ providerSubject: code, handle: code, displayName: code }),
  };
  const { store, bootstrapSecret } = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider });
  if (!bootstrapSecret) throw new Error('Expected fresh fixture');
  const owner = await store.consumeBootstrap({ secret: bootstrapSecret, displayName: 'Owner' });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'bind' },
    sessionToken: owner.sessionToken,
  });
  const completion = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'owner' });
  await store.exchangeHumanAuthCompletion(completion.completionToken);
  const collective = await store.createCollective({ sessionToken: owner.sessionToken, name: 'Participation' });
  const coordinates = { serviceInstanceId: store.serviceInstanceId, collectiveId: collective.collectiveId };
  const pair = async () => {
    const intent = await store.createPairingIntent({
      sessionToken: owner.sessionToken,
      collectiveId: collective.collectiveId,
      hostOrigin: 'http://localhost:5182',
      nonce: 'participation-test-nonce',
    });
    return store.exchangePairingIntent({ ...intent, endpointLabel: 'Editable label' });
  };
  const connection = await pair();
  return { store, owner, coordinates, connection, pair, humanAuthProvider };
}
