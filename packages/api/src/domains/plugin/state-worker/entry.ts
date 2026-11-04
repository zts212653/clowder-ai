import { parentPort } from 'node:worker_threads';
import { verifyPackageAdmission } from '../host-inventory/manifest-verifier.js';
import { PluginStateDatabase, readCommittedOutcome } from './database.js';
import type { StateDomain, StateRequest, StateResponse } from './protocol.js';
import { cachedContract } from './records.js';

const databases = new Map<StateDomain, PluginStateDatabase>();
parentPort?.on('message', ({ id, operation }: StateRequest) => {
  try {
    let value: unknown;
    if (operation.op === 'outcome') {
      value = readCommittedOutcome(operation.path, operation.transaction);
    } else if (operation.op === 'open') {
      if (databases.has(operation.domain) && databases.get(operation.domain)?.path !== operation.path)
        throw new Error('Plugin state domain already belongs to another path');
      if (!databases.has(operation.domain))
        databases.set(operation.domain, new PluginStateDatabase(operation.domain, operation.path));
    } else {
      const db = databases.get(operation.domain);
      if (!db) throw new Error('Plugin state database is not open');
      switch (operation.op) {
        case 'hasRecords':
          value = db.hasRecords();
          break;
        case 'verifyAdmission':
          value = verifyPackageAdmission(operation.candidate, operation.now, cachedContract);
          break;
        case 'begin':
          value = db.begin(operation.transaction, operation.acknowledgedTransaction);
          break;
        case 'commit':
          value = db.finish(operation.transaction, true);
          break;
        case 'rollback':
          value = db.finish(operation.transaction, false);
          break;
        case 'authority':
          value = db.authority(operation.instanceId, operation.byPlugin);
          break;
        case 'connection':
          value = db.connectionState(operation.connectionId);
          break;
        case 'get':
          value = db.query(operation.query, operation.transaction)[0];
          break;
        case 'list':
          value = db.page(operation.query, operation.transaction);
          break;
        case 'put':
          value = db.put(operation.entity, operation.value, operation.transaction);
          break;
        case 'activation':
          value = db.featureActivation(
            operation.instanceId,
            operation.featureId,
            operation.sessionId,
            operation.transaction,
          );
          break;
        case 'features':
          value = db.features(operation.instanceId, operation.transaction, operation.activeOnly);
          break;
        case 'putFeatures':
          value = db.putFeatures(operation.value, operation.instanceId, operation.transaction, operation.updateOnly);
          break;
      }
    }
    parentPort?.postMessage({ id, value } satisfies StateResponse);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    parentPort?.postMessage({
      id,
      error: { name: error.name, message: error.message, ...('code' in error ? { code: String(error.code) } : {}) },
    } satisfies StateResponse);
  }
});
