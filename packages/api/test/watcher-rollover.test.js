import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { watcherRolloverCases } from './helpers/watcher-rollover-cases.js';

watcherRolloverCases(() => new SessionChainStore());
