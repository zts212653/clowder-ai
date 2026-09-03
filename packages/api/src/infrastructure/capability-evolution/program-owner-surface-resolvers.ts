import type { ProgramOwnerSurfaceResolver } from './program-join-validator.js';

interface PawFeelDiscovery {
  type: string;
  source?: {
    sourceMessageId: string;
    sourceThreadId: string;
  };
}

interface EvolutionOwnerSurfaceResolverDependencies {
  pawFeelEventLog?: {
    read(signalId: string): Promise<PawFeelDiscovery[]>;
  };
  humanDispositionLedger?: {
    get(ownerUserId: string, sourceRef: string): Promise<{ episode: { subjectRef: string } } | null>;
  };
  threadStore: {
    get(
      threadId: string,
    ):
      | { createdBy: string; deletedAt?: number | null }
      | Promise<{ createdBy: string; deletedAt?: number | null } | null>
      | null;
  };
}

function coordinates(
  ownerFeatureId: string,
  ownerStatePrefix: string,
  joinPrefix: string,
  instrumentationStateRef: string,
): (input: Parameters<ProgramOwnerSurfaceResolver>[0]) => { ownerId: string; joinId: string } | undefined {
  return (input) => {
    if (
      input.ownerSurfaceRef.ownerFeatureId !== ownerFeatureId ||
      !input.ownerSurfaceRef.ownerStateRef.startsWith(ownerStatePrefix) ||
      !input.joinKey.startsWith(joinPrefix) ||
      input.instrumentationRef.ownerFeatureId !== ownerFeatureId ||
      input.instrumentationRef.ownerStateRef !== instrumentationStateRef
    ) {
      return undefined;
    }
    return {
      ownerId: input.ownerSurfaceRef.ownerStateRef.slice(ownerStatePrefix.length),
      joinId: input.joinKey.slice(joinPrefix.length),
    };
  };
}

export function createEvolutionOwnerSurfaceResolvers(
  dependencies: EvolutionOwnerSurfaceResolverDependencies,
): Record<string, ProgramOwnerSurfaceResolver> {
  const pawFeelCoordinates = coordinates('F278', 'paw-feel:', 'message:', 'instrumentation:paw-feel-v1');
  const humanDispositionCoordinates = coordinates(
    'F281',
    'human-disposition:',
    'subject:',
    'instrumentation:human-disposition-v1',
  );
  return {
    'paw-feel-disposition': async (input) => {
      const resolved = pawFeelCoordinates(input);
      if (!resolved) return { status: 'missing' };
      if (!dependencies.pawFeelEventLog) throw new Error('F278 paw-feel owner read port is unavailable');
      const events = await dependencies.pawFeelEventLog.read(resolved.ownerId);
      const discovery = events.find(
        (event) => event.type === 'discovered' && event.source?.sourceMessageId === resolved.joinId,
      );
      if (!discovery?.source) return { status: 'missing' };
      const sourceThread = await dependencies.threadStore.get(discovery.source.sourceThreadId);
      return sourceThread && !sourceThread.deletedAt && sourceThread.createdBy === input.ownerUserId
        ? { status: 'resolved' }
        : { status: 'missing' };
    },
    'human-disposition': async (input) => {
      const resolved = humanDispositionCoordinates(input);
      if (!resolved) return { status: 'missing' };
      if (!dependencies.humanDispositionLedger) {
        throw new Error('F281 human-disposition owner read port is unavailable');
      }
      const entry = await dependencies.humanDispositionLedger.get(input.ownerUserId, resolved.ownerId);
      return entry?.episode.subjectRef === resolved.joinId ? { status: 'resolved' } : { status: 'missing' };
    },
  };
}
