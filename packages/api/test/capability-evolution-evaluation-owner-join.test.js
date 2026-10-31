import { test } from 'node:test';
import {
  createMeasurementCertificateFixture,
  createMeasurementResultFixture,
} from './harness-eval/helpers/measurement-certificate-fixture.js';
import { assertMeasurementOwnerJoin } from './helpers/measurement-owner-join-contract.js';

test('F311 owner join composes real F267 normalization over independent measurement facts', async (t) => {
  const certificate = await createMeasurementCertificateFixture();
  const result = createMeasurementResultFixture(certificate);
  await assertMeasurementOwnerJoin(t, {
    certificate,
    result,
    resultRef: 'test/fixtures/owner-join-result.yaml',
    ownerUserId: 'fixture-owner',
  });
});
