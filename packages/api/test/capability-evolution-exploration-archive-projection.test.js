import { verifyExplorationProjectionRecovery } from './capability-evolution-exploration-projection-recovery.helper.mjs';
import { createExplorationArchiveFixture } from './fixtures/microduck-exploration-archive.fixture.js';

verifyExplorationProjectionRecovery('public-federation', {
  createArchiveFixture: createExplorationArchiveFixture,
  archiveNodeCount: 5,
  experimentCount: 6,
});
