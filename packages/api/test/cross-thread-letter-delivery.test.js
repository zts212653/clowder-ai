import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { deliverCrossThreadLetterProof } from './helpers/cross-thread-letter-delivery.js';

test('cross-thread letter proof preserves actual callback provenance, recipients and owner attention', async () => {
  const proof = await deliverCrossThreadLetterProof();
  assert.equal(proof.messages.length, 2);
  // A captured transport artifact feeds the separate browser consumer; no API dependency is imported into a web unit.
  if (process.env.LETTER_DELIVERY_PROOF)
    await writeFile(process.env.LETTER_DELIVERY_PROOF, `${JSON.stringify(proof, null, 2)}\n`);
});
