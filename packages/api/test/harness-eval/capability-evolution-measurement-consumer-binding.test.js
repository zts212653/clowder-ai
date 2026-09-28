import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stringify } from 'yaml';

import { program, sha256, sourceManifestFromEvidence } from './capability-evolution-measurement-fixtures.js';
import {
  createMeasurementCertificateFixture,
  createMeasurementResultFixture,
} from './helpers/measurement-certificate-fixture.js';

const VALUE_OWNER_REF = { ownerFeatureId: 'F311', ownerStateRef: 'user:operator' };
const NAMED_CONSUMER_REF = { ownerFeatureId: 'F100', ownerStateRef: 'cat:opus' };

async function loadValidators() {
  return Promise.all([
    import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source.js'
    ),
    import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-validation.js'
    ),
  ]);
}

async function distinctConsumerFixture() {
  const certificate = await createMeasurementCertificateFixture();
  const manifest = sourceManifestFromEvidence(certificate, createMeasurementResultFixture(certificate));
  manifest.certificate.decision.consumerFeatureId = NAMED_CONSUMER_REF.ownerFeatureId;
  manifest.certificate.decision.consumerOwnerCatId = 'opus';
  manifest.roles.consumer = NAMED_CONSUMER_REF;
  const consumerReceipt = manifest.ownerObjects.find((entry) => entry.artifact.objectType === 'consumer_consumption');
  assert.ok(consumerReceipt);
  consumerReceipt.artifact.ownerFeatureId = NAMED_CONSUMER_REF.ownerFeatureId;
  consumerReceipt.artifact.consumerFeatureId = NAMED_CONSUMER_REF.ownerFeatureId;
  consumerReceipt.artifact.consumerOwnerCatId = 'opus';
  manifest.decisionProof.consumerConsumption.consumerFeatureId = NAMED_CONSUMER_REF.ownerFeatureId;
  manifest.decisionProof.consumerConsumption.consumerOwnerCatId = 'opus';
  manifest.decisionProof.consumerConsumption.receipt.ownerFeatureId = NAMED_CONSUMER_REF.ownerFeatureId;
  manifest.decisionProof.consumerConsumption.receipt.sha256 = sha256(Buffer.from(stringify(consumerReceipt.artifact)));
  manifest.decisionProof.subject.certificateSha256 = sha256(Buffer.from(stringify(manifest.certificate)));
  const projection = program();
  projection.program.valueOwnerRef = VALUE_OWNER_REF;
  return { manifest, projection };
}

describe('F267 capability-evolution consumer and value-owner binding', () => {
  it('accepts a certificate-named measurement consumer distinct from the Program value owner', async () => {
    const [{ CapabilityEvolutionMeasurementSourceSchema }, { validateCapabilityEvolutionMeasurementSource }] =
      await loadValidators();
    const { manifest, projection } = await distinctConsumerFixture();

    CapabilityEvolutionMeasurementSourceSchema.parse(manifest);
    assert.doesNotThrow(() =>
      validateCapabilityEvolutionMeasurementSource({ manifest, projection, ownerUserId: 'operator' }),
    );
  });

  it('rejects a missing or forged named consumer', async () => {
    const [{ CapabilityEvolutionMeasurementSourceSchema }, { validateCapabilityEvolutionMeasurementSource }] =
      await loadValidators();
    const missing = await distinctConsumerFixture();
    delete missing.manifest.roles.consumer;
    assert.throws(() => CapabilityEvolutionMeasurementSourceSchema.parse(missing.manifest));

    const forged = await distinctConsumerFixture();
    forged.manifest.roles.consumer = { ...NAMED_CONSUMER_REF, ownerStateRef: 'cat:attacker' };
    CapabilityEvolutionMeasurementSourceSchema.parse(forged.manifest);
    assert.throws(
      () =>
        validateCapabilityEvolutionMeasurementSource({
          manifest: forged.manifest,
          projection: forged.projection,
          ownerUserId: 'operator',
        }),
      /named consumer role mismatch/,
    );
  });

  it('rejects Program value-owner drift even when the named consumer is valid', async () => {
    const [{ CapabilityEvolutionMeasurementSourceSchema }, { validateCapabilityEvolutionMeasurementSource }] =
      await loadValidators();
    const { manifest, projection } = await distinctConsumerFixture();
    projection.program.valueOwnerRef = { ownerFeatureId: 'F311', ownerStateRef: 'user:attacker' };
    CapabilityEvolutionMeasurementSourceSchema.parse(manifest);

    assert.throws(
      () => validateCapabilityEvolutionMeasurementSource({ manifest, projection, ownerUserId: 'operator' }),
      /value owner mismatch/,
    );
  });

  it('rejects an active Program without an explicit value owner', async () => {
    const [{ CapabilityEvolutionMeasurementSourceSchema }, { validateCapabilityEvolutionMeasurementSource }] =
      await loadValidators();
    const { manifest, projection } = await distinctConsumerFixture();
    delete projection.program.valueOwnerRef;
    CapabilityEvolutionMeasurementSourceSchema.parse(manifest);

    assert.throws(
      () => validateCapabilityEvolutionMeasurementSource({ manifest, projection, ownerUserId: 'operator' }),
      /value owner missing/,
    );
  });
});
