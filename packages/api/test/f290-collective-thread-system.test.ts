import { test } from 'node:test';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { verifyCollectiveThreadSystem } from './helpers/f290-collective-thread-contract.js';

test('system classification is exact-owner CAS without overwriting another system kind', async () =>
  verifyCollectiveThreadSystem(new ThreadStore()));
