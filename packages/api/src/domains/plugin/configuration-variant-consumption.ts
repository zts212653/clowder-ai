/**
 * configurationVariants (contractVersion 0.2.0) consumption boundary (design §2.4/§3).
 *
 * The Host never interprets variant declarations itself: requiredness, branch
 * selection, effective-value computation, and validation-schema compilation are
 * owned by `@clowder-ai/plugin-contract` (`./variant` subpath, browser-safe pure
 * functions). This module only wires Host storage values into those functions
 * and gates every consumer on the declaration being *present*.
 *
 * Presence discipline (astra round-two P1): only a manifest whose
 * `configurationVariants` is `undefined` takes the legacy path, byte-for-byte.
 * A declaration that exists but is malformed never reaches this module — Host
 * admission validates every manifest through the contract package, which
 * rejects a malformed declaration at install time.
 */

import { createRequire } from 'node:module';
import type { ConfigurationField, PluginManifest } from '@clowder-ai/plugin-contract';
import {
  buildVariantValidationSchema,
  computeEffectiveConfiguration,
  evaluateFieldRequiredness,
  resolveConfigurationVariant,
} from '@clowder-ai/plugin-contract/variant';
import { Ajv } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';

const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;

export type { VariantResolution } from '@clowder-ai/plugin-contract/variant';

export type StoredConfigurationValues = Readonly<Record<string, unknown>>;

/** Undefined declaration means the plugin predates 0.2.0 — consumers keep the legacy path. */
export function declaresConfigurationVariants(manifest: PluginManifest): boolean {
  return manifest.configurationVariants !== undefined;
}

/** Three-state branch selection (`selected` / `unselected` / `invalid`), owned by the contract. */
export function resolveVariant(manifest: PluginManifest, values: StoredConfigurationValues) {
  return resolveConfigurationVariant(manifest, values);
}

/**
 * Effective configuration = common fields + selected-branch values, with declared
 * defaults applied inside the contract (no consumer depends on save-time
 * materialization, and invalid stored values never fall back to a default).
 */
export function effectiveConfiguration(manifest: PluginManifest, storedValues: StoredConfigurationValues) {
  return computeEffectiveConfiguration(manifest, storedValues);
}

/** The single requiredness source: `requiredWhen` fully replaces `required` (strict ===). */
export function variantFieldRequiredness(field: ConfigurationField, values: StoredConfigurationValues): boolean {
  return evaluateFieldRequiredness(field, values);
}

type ValidateEffective = (values: Record<string, unknown>) => boolean;

/** One compiled validator per manifest object; admission snapshotted manifests are stable. */
const effectiveValidators = new WeakMap<PluginManifest, ValidateEffective>();

/**
 * Validates the *effective* configuration object (the product of
 * {@link effectiveConfiguration}) against the contract-compiled schema.
 * Readiness uses this: `selected` and schema-valid ⇒ ready.
 */
export function effectiveConfigurationIsValid(
  manifest: PluginManifest,
  effectiveValues: Record<string, unknown>,
): boolean {
  let validate = effectiveValidators.get(manifest);
  if (!validate) {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    validate = ajv.compile(buildVariantValidationSchema(manifest)) as ValidateEffective;
    effectiveValidators.set(manifest, validate);
  }
  return validate(effectiveValues) === true;
}
