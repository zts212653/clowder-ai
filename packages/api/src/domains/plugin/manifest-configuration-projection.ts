/**
 * F202 Train C1 gap C — decide which manifest-declared configuration an instance may actually
 * read, then deliver that decision to whichever runtime carrier is loading the package.
 *
 * CARRIER NEUTRALITY (C1 clause 1+2, plan §8.6 step 4). The decision and its delivery are two
 * different things, and only the delivery is carrier-specific:
 *   - {@link resolveManifestConfiguration} owns the decision. It is the single authority, and it
 *     keeps each field's `kind`, because the in-process module carrier hands a plugin a
 *     `FeatureContext` whose `config` and `secrets` are separate namespaces (plugin-sdk
 *     `feature-context.d.ts`). Flattening them away here would force that carrier to re-derive
 *     `kind` and thereby fork the authority this module exists to centralise.
 *   - {@link projectManifestConfigurationEnv} is the spawned-child delivery: that same resolution
 *     flattened into environment variables. It is the only carrier-specific part.
 * Rule 1 below stays a *manifest-level* refusal rather than an env-only one for the same reason:
 * carrier-dependent admission would itself leak the carrier into the domain (clause 1).
 *
 * The declared MCP path performs exactly this grant-checked projection
 * (`declared/declared-mcp-resources.ts`) from a contribution's explicit
 * `environment` bindings. A migrated npm package has no such contribution: it declares plain
 * `configuration` fields and reads them as environment variables, which is why the stdio spawn
 * path needs its own projection rather than a reuse of the contribution one.
 *
 * Three fail-closed rules, in the order a caller hits them:
 *  1. `CLOWDER_` is the Host's protocol namespace on the child (supervisor.ts spawn env). A
 *     manifest field landing there would let a package restate its own Host-issued identity, so
 *     a declared key inside that namespace refuses the projection instead of being overridden.
 *  2. A field is projected only if the instance actually holds the grant its kind requires —
 *     `secret.read` for secrets, `plugin.config.read` otherwise. An ungranted field is never read
 *     into the child, even when a value is stored.
 *  3. A required field with no effective value refuses the projection: a provider that cannot
 *     authenticate must fail closed rather than start blind.
 *
 * Rule 2 does not short-circuit rule 3 (sixth-round review P1). Missing *authority* and an absent
 * *optional* value are different outcomes for a required field: skipping an ungranted required
 * field would start the child blind, which is precisely what rule 3 exists to prevent. So an
 * ungranted field is omitted only when it is optional, and refuses when it is required.
 */

import { isPluginConfigurationFieldRequired } from '@cat-cafe/shared';
import type { ConfigurationField, PluginManifest } from '@clowder-ai/plugin-contract';
import {
  effectiveConfiguration,
  resolveVariant,
  variantFieldRequiredness,
} from './configuration-variant-consumption.js';
import { hostCapabilityRefusal } from './host-surface/host-capability-refusal.js';
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
  | {
      readonly reason: 'grant_unavailable';
      readonly key: string;
      readonly kind: ConfigurationField['kind'];
      readonly grant: string;
    }
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
    if (failure.reason === 'grant_unavailable') {
      return `required ${failure.kind} ${failure.key} needs the ${failure.grant} grant this instance does not hold`;
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

function requiredGrant(field: ConfigurationField): 'secret.read' | 'plugin.config.read' {
  return field.kind === 'secret' ? 'secret.read' : 'plugin.config.read';
}

export interface ManifestConfigurationProjectionInput {
  readonly pluginInstanceId: string;
  readonly manifest: PluginManifest;
  readonly effectiveGrants: readonly string[];
  readonly configuration: PluginRuntimeConfigurationPort;
}

/** One declared field this instance is allowed to read, with the kind its carrier routes on. */
export interface ResolvedConfigurationField {
  readonly key: string;
  readonly kind: ConfigurationField['kind'];
  readonly value: string;
}

/**
 * Applies all three rules to one declared field — the unit a carrier-neutral decision is made in.
 * Returns `undefined` when an *optional* field is legitimately absent (rules 2 and 3); throws when
 * a *required* one cannot be satisfied.
 */
async function resolveDeclaredField(
  field: ConfigurationField,
  grants: ReadonlySet<string>,
  required: boolean,
  effectiveValue: () => Promise<string | undefined>,
): Promise<ResolvedConfigurationField | undefined> {
  if (field.key.startsWith(HOST_PROTOCOL_ENV_PREFIX)) {
    throw new ManifestConfigurationProjectionError({ reason: 'protocol_namespace', key: field.key });
  }
  const grant = requiredGrant(field);
  if (!grants.has(grant)) {
    // Rule 3 outranks rule 2 for a required field: a provider that cannot read its own
    // mandatory authority must refuse, not start without it.
    if (required) {
      throw hostCapabilityRefusal(
        new ManifestConfigurationProjectionError({
          reason: 'grant_unavailable',
          key: field.key,
          kind: field.kind,
          grant,
        }),
        grant,
      );
    }
    return undefined;
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
  const grants = new Set(input.effectiveGrants);
  // Operations describe owner actions and have no config/secret value to project.
  // Their target fields carry the resulting values and retain their own grants.
  const fields = (input.manifest.configuration ?? []).filter((field) => field.kind !== 'operation');
  const variants = input.manifest.configurationVariants;
  if (variants !== undefined) {
    return resolveVariantManifestConfiguration(input, grants, fields, variants);
  }
  const resolved: ResolvedConfigurationField[] = [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const values = new Map<string, Promise<string | undefined>>();
  async function effectiveValue(field: ConfigurationField): Promise<string | undefined> {
    let pending = values.get(field.key);
    if (!pending) {
      pending = (async () => {
        // The condition may reference a field without its read grant. Never inspect its store.
        if (!grants.has(requiredGrant(field))) return effectivePluginConfigurationValue(field, undefined);
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
    const entry = await resolveDeclaredField(field, grants, required, () => effectiveValue(field));
    if (entry !== undefined) resolved.push(entry);
  }
  return resolved;
}

/**
 * Variant-declared resolution (design §3.3). The contract owns branch
 * selection, default application, and requiredness; the Host only feeds it
 * grant-checked raw stored values and delivers the resulting active set.
 *
 * Fail-closed on the two non-`selected` statuses: a package whose variant is
 * unselected or invalid must not start, and inactive-branch fields are never
 * read into the runtime (they are absent from `effectiveValues`, so the
 * delivery loop below skips them without touching the store).
 */
async function resolveVariantManifestConfiguration(
  input: ManifestConfigurationProjectionInput,
  grants: ReadonlySet<string>,
  fields: readonly ConfigurationField[],
  variants: NonNullable<PluginManifest['configurationVariants']>,
): Promise<readonly ResolvedConfigurationField[]> {
  const rawValues = new Map<string, Promise<unknown>>();
  function rawValue(field: ConfigurationField): Promise<unknown> {
    let pending = rawValues.get(field.key);
    if (!pending) {
      pending = (async () => {
        // Same grant discipline as the legacy path: no grant, no store read.
        // The contract then applies the declared default for that field.
        if (!grants.has(requiredGrant(field))) return undefined;
        return field.kind === 'secret'
          ? input.configuration.readSecret(input.pluginInstanceId, field.key)
          : input.configuration.readConfig(input.pluginInstanceId, field.key);
      })();
      rawValues.set(field.key, pending);
    }
    return pending;
  }
  // Phase 1: resolve the branch from the discriminator alone (grant-gated;
  // the contract falls back to the discriminator field's declared default).
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
    const entry = await resolveDeclaredField(field, grants, required, async () =>
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
