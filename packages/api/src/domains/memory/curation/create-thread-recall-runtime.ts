import type Database from 'better-sqlite3';
import { readCurationPreference } from '../../../config/user-preferences-curation.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { ThreadOverviewMemoryCueSource } from '../cue/sources/ThreadOverviewMemoryCueSource.js';
import { resolveCurationProvider } from '../curation-provider.js';
import { LunaThreadLibrarian } from './LunaThreadLibrarian.js';
import { ThreadOverviewRepository } from './ThreadOverviewRepository.js';

export function createThreadRecallSource(input: {
  db: Database.Database;
  projectRoot: string;
  ownerUserId: string;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  logger: { info: (fields: object, message: string) => void };
}) {
  const repository = new ThreadOverviewRepository(input);
  const preference = () => readCurationPreference(input.projectRoot);
  const librarian = new LunaThreadLibrarian({
    repository,
    workingDirectory: input.projectRoot,
    resolveProvider: () => resolveCurationProvider(input.projectRoot, preference().curatorCatId),
    onDirectory: (directory) =>
      input.logger.info(
        { coverage: directory.coverage, directoryChars: JSON.stringify(directory.entries).length },
        '[F321] complete readable thread directory',
      ),
    onObservation: (observation) => input.logger.info(observation, '[F321] native librarian usage and latency'),
  });
  return new ThreadOverviewMemoryCueSource({
    repository,
    librarian,
    messageStore: input.messageStore,
    enabled: () => preference().enabled,
  });
}
