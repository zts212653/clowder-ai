import { test } from 'node:test';
import { runDirectWitnessScenario } from './helpers/issue1371-direct-witness-harness.js';

const cases = ['message', 'retry', 'connector', 'standalone A2A', 'podcast'].flatMap((ingress) =>
  ['user-1', 'scheduler'].map((messageUserId) => ({ ingress, messageUserId, proof: 'exact' })),
);
for (const proof of ['missing', 'wrong child', 'wrong source', 'wrong task']) {
  cases.push({ ingress: 'message', messageUserId: 'scheduler', proof });
}
for (const { ingress, messageUserId, proof } of cases) {
  test(`#1371: ${ingress} adopted custody and automatic review (${messageUserId}, ${proof})`, (t) =>
    runDirectWitnessScenario(t, { ingress, messageUserId, proof }));
}
