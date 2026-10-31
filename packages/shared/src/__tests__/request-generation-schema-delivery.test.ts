import { describe, expect, it } from 'vitest';
import { requestGenerationSchemaDeliverySchema } from '../types/request-generation-envelope.js';

const base = {
  profileClass: 'full' as const,
  profileId: 'full',
};

describe('F286 request-generation schema-delivery evidence contract', () => {
  it.each([
    'provider-native-deferred',
    'catalog-deferred',
    'upfront',
  ] as const)('rejects an unproven %s delivery claim', (requestedMode) => {
    expect(
      requestGenerationSchemaDeliverySchema.safeParse({
        ...base,
        requestedMode,
      }).success,
    ).toBe(false);
    expect(
      requestGenerationSchemaDeliverySchema.safeParse({
        ...base,
        requestedMode,
        hostVersion: '2.1.247',
      }).success,
    ).toBe(false);
    expect(
      requestGenerationSchemaDeliverySchema.safeParse({
        ...base,
        requestedMode,
        attestation: {
          ref: 'docs/features/evidence/F286/provider-schema-delivery/fixture.json',
          digest: `sha256:${'d'.repeat(64)}`,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    'provider-native-deferred',
    'catalog-deferred',
    'upfront',
  ] as const)('accepts an evidence-bound %s delivery claim', (requestedMode) => {
    expect(
      requestGenerationSchemaDeliverySchema.safeParse({
        ...base,
        requestedMode,
        hostVersion: '2.1.247',
        attestation: {
          ref: 'docs/features/evidence/F286/provider-schema-delivery/fixture.json',
          digest: `sha256:${'d'.repeat(64)}`,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    'host-default',
    'always-visible',
  ] as const)('keeps %s as an explicit configuration-only request without claiming observed delivery', (requestedMode) => {
    expect(
      requestGenerationSchemaDeliverySchema.safeParse({
        ...base,
        requestedMode,
      }).success,
    ).toBe(true);
  });
});
