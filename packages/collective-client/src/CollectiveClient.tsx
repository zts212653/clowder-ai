import { CollectiveWorkspace } from './CollectiveWorkspace.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import { OnboardingScene } from './OnboardingScene.js';
import { ProductShell } from './ProductShell.js';
import { useCollectiveClient } from './use-collective-client.js';
import { useHostWorldDirectory } from './use-host-world-directory.js';

export function CollectiveClient() {
  const hostOrigin = new URLSearchParams(location.search).get('hostOrigin');
  const embedded = window.parent !== window && hostOrigin !== null;
  return <LiveCollectiveClient embedded={embedded} />;
}

function LiveCollectiveClient({ embedded }: { readonly embedded: boolean }) {
  const client = useCollectiveClient();
  const { snapshot } = client;
  useHostWorldDirectory({ embedded, snapshot, selectCollective: client.selectCollective });
  const canSteward = snapshot.collective?.role === 'steward';
  const canPair = snapshot.phase === 'ready' && Boolean(snapshot.me?.auth && snapshot.collective);

  if (snapshot.phase === 'ready' && snapshot.collective && snapshot.me) {
    return <CollectiveWorkspace key={collectiveClientNamespace(snapshot)} embedded={embedded} client={client} />;
  }

  return (
    <ProductShell
      embedded={embedded}
      collective={snapshot.collective}
      collectives={snapshot.me?.collectives}
      onSelectCollective={client.selectCollective}
      connection={snapshot.connection}
      canSteward={canSteward}
      canPair={canPair}
      canLeave={false}
      notice={snapshot.notice}
      onInvite={() => void client.createInvite()}
      onPair={() => void client.pairHost()}
      onLeave={() => undefined}
    >
      {snapshot.phase === 'ready' && snapshot.me ? (
        <p className="channel-empty">选择一个共同家园，继续交流。</p>
      ) : (
        <OnboardingScene
          phase={snapshot.phase}
          mode={client.invitationMode}
          providers={snapshot.providers}
          hasAuthenticatedHuman={Boolean(snapshot.me?.auth)}
          error={snapshot.error}
          onBootstrap={client.bootstrap}
          onAuthenticate={client.authenticate}
          onConfigureProvider={client.configureProvider}
          onCreateCollective={client.createCollective}
        />
      )}
    </ProductShell>
  );
}
