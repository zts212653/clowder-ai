/** Resolves declared configuration once for both module and spawned-child carriers.
 * Only active variant fields are read; required values and protocol namespaces remain validated.
 */

import { isPluginConfigurationFieldRequired } from '@cat-cafe/shared';
import type { ConfigurationField, PluginManifest } from '@clowder-ai/plugin-contract';
import {
  effectiveConfiguration,
  resolveVariant,
  variantFieldRequiredness,
} from './configuration-variant-consumption.js';
import { effectivePluginConfigurationValue } from './manager/plugin-configuration-values.js';

/** The environment namespace the Host owns on every spawned child. */
export const HOST_PROTOCOL_ENV_PREFIX = 'CLOWDER_';

export interface PluginRuntimeConfigurationPort {
  readConfig(pluginInstanceId: string, key: string): Promise<unknown>;
  readSecret(pluginInstanceId: string, key: string): Promise<string | undefined>;
}

export type ManifestConfigurationProjectionFailure =
  | { readonly reason: 'protocol_namespace'; readonly key: string }
  | { readonly reason: 'value_unavailable'; readonly key: string; readonly kind: ConfigurationField['kind'] }
  | { readonly reason: 'variant_unselected' }
  | { readonly reason: 'variant_invalid'; readonly value: unknown };

export class ManifestConfigurationProjectionError extends Error {
  constructor(readonly failure: ManifestConfigurationProjectionFailure) {
    super(ManifestConfigurationProjectionError.describe(failure));
    this.name = 'ManifestConfigurationProjectionError';
  }

  private static describe(failure: ManifestConfigurationProjectionFailure): string {
    if (failure.reason === 'protocol_namespace') {
      return `configuration key ${failure.key} is inside the ${HOST_PROTOCOL_ENV_PREFIX} protocol namespace and cannot be projected`;
    }
    if (failure.reason === 'variant_unselected') {
      return 'configuration variant is unselected: no discriminator value is stored and none is declared as its default';
    }
    if (failure.reason === 'variant_invalid') {
      return `configuration variant discriminator value ${JSON.stringify(failure.value)} matches no declared branch`;
    }
    return `required ${failure.kind} ${failure.key} is unavailable`;
  }
}

export interface ManifestConfigurationProjectionInput {
  readonly pluginInstanceId: string;
  readonly manifest: PluginManifest;
  readonly configuration: PluginRuntimeConfigurationPort;
}

/** One declared field this instance is allowed to read, with the kind its carrier routes on. */
export interface ResolvedConfigurationField {
  readonly key: string;
  readonly kind: ConfigurationField['kind'];
  readonly value: string;
}

async function resolveDeclaredField(
  field: ConfigurationField,
  required: boolean,
  effectiveValue: () => Promise<string | undefined>,
): Promise<ResolvedConfigurationField | undefined> {
  if (field.key.startsWith(HOST_PROTOCOL_ENV_PREFIX)) {
    throw new ManifestConfigurationProjectionError({ reason: 'protocol_namespace', key: field.key });
  }

  const value = await effectiveValue();
  if (value === undefined || value.length === 0) {
    if (required) {
      throw new ManifestConfigurationProjectionError({ reason: 'value_unavailable', key: field.key, kind: field.kind });
    }
    return undefined;
  }
  return { key: field.key, kind: field.kind, value };
}

/**
 * Resolves the declared configuration a verified package may actually read, in declaration order.
 * Throws {@link ManifestConfigurationProjectionError} rather than degrading, so no carrier can
 * start an instance that is missing an authority it declared as required.
 */
export async function resolveManifestConfiguration(
  input: ManifestConfigurationProjectionInput,
): Promise<readonly ResolvedConfigurationField[]> {
  // Operations describe owner actions and have no config/secret value to project.
  // Their target fields carry the resulting values.
  const fields = (input.manifest.configuration ?? []).filter((field) => field.kind !== 'operation');
  const variants = input.manifest.configurationVariants;
  if (variants !== undefined) {
    return resolveVariantManifestConfiguration(input, fields, variants);
  }
  const resolved: ResolvedConfigurationField[] = [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const values = new Map<string, Promise<string | undefined>>();
  async function effectiveValue(field: ConfigurationField): Promise<string | undefined> {
    let pending = values.get(field.key);
    if (!pending) {
      pending = (async () => {
        const stored =
          field.kind === 'secret'
            ? await input.configuration.readSecret(input.pluginInstanceId, field.key)
            : await input.configuration.readConfig(input.pluginInstanceId, field.key);
        return effectivePluginConfigurationValue(field, stored);
      })();
      values.set(field.key, pending);
    }
    return pending;
  }
  for (const field of fields) {
    const referenced = field.requiredWhen ? byKey.get(field.requiredWhen.key) : undefined;
    const referencedValue = referenced ? await effectiveValue(referenced) : undefined;
    const required = isPluginConfigurationFieldRequired(field, () => referencedValue);
    const entry = await resolveDeclaredField(field, required, () => effectiveValue(field));
    if (entry !== undefined) resolved.push(entry);
  }
  return resolved;
}

/**
 * Variant-declared resolution (design §3.3). The contract owns branch
 * selection, default application, and requiredness; the Host only feeds it
 * raw stored values and delivers the resulting active set.
 *
 * Fail-closed on the two non-`selected` statuses: a package whose variant is
 * unselected or invalid must not start, and inactive-branch fields are never
 * read into the runtime (they are absent from `effectiveValues`, so the
 * delivery loop below skips them without touching the store).
 */
async function resolveVariantManifestConfiguration(
  input: ManifestConfigurationProjectionInput,
  fields: readonly ConfigurationField[],
  variants: NonNullable<PluginManifest['configurationVariants']>,
): Promise<readonly ResolvedConfigurationField[]> {
  const rawValues = new Map<string, Promise<unknown>>();
  function rawValue(field: ConfigurationField): Promise<unknown> {
    let pending = rawValues.get(field.key);
    if (!pending) {
      pending = (async () => {
        return field.kind === 'secret'
          ? input.configuration.readSecret(input.pluginInstanceId, field.key)
          : input.configuration.readConfig(input.pluginInstanceId, field.key);
      })();
      rawValues.set(field.key, pending);
    }
    return pending;
  }
  // Phase 1: resolve the branch from the stored discriminator or its declared default.
  // Fail-closed before any other store read: an unselected or invalid
  // variant must not start, and we must not know what an inactive branch
  // stores.
  const probe: Record<string, unknown> = {};
  const discriminatorField = fields.find((field) => field.key === variants.discriminator);
  if (discriminatorField) {
    const value = await rawValue(discriminatorField);
    if (value !== undefined) probe[variants.discriminator] = value;
  }
  const resolution = resolveVariant(input.manifest, probe);
  if (resolution.status === 'unselected') {
    throw new ManifestConfigurationProjectionError({ reason: 'variant_unselected' });
  }
  if (resolution.status === 'invalid') {
    throw new ManifestConfigurationProjectionError({ reason: 'variant_invalid', value: resolution.value });
  }
  // Phase 2: read only what the selected branch may deliver — common fields
  // (claimed by no branch) plus the selected branch's fields. Inactive-branch
  // fields are never touched in the store.
  const claimedKeys = new Set<string>();
  for (const branch of variants.branches) for (const key of branch.fields) claimedKeys.add(key);
  const activeBranch = variants.branches.find((branch) => branch.id === resolution.branchId);
  const activeKeys = new Set(activeBranch?.fields ?? []);
  const stored: Record<string, unknown> = {};
  for (const field of fields) {
    if (claimedKeys.has(field.key) && !activeKeys.has(field.key)) continue;
    const value = await rawValue(field);
    if (value !== undefined) stored[field.key] = value;
  }
  const { effectiveValues } = effectiveConfiguration(input.manifest, stored);
  const resolved: ResolvedConfigurationField[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(effectiveValues, field.key)) continue;
    const required = variantFieldRequiredness(field, effectiveValues);
    const entry = await resolveDeclaredField(field, required, async () =>
      effectivePluginConfigurationValue(field, effectiveValues[field.key]),
    );
    if (entry !== undefined) resolved.push(entry);
  }
  return resolved;
}

/**
 * Spawned-child delivery of {@link resolveManifestConfiguration}: the environment a verified
 * package may receive on top of the protocol variables. Every refusal is the resolver's.
 */
export async function projectManifestConfigurationEnv(
  input: ManifestConfigurationProjectionInput,
): Promise<Readonly<Record<string, string>>> {
  const env: Record<string, string> = {};
  for (const field of await resolveManifestConfiguration(input)) env[field.key] = field.value;
  return env;
}
