import type { ConfigurationField as ContractConfigurationField, PluginManifest } from '@clowder-ai/plugin-contract';
import { coerceStoredValues, resolveConfigurationVariant } from '@clowder-ai/plugin-contract/variant';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

type ConfigurationField = NonNullable<PluginManagerDesignFixture['configFields']>[number];

export function serializedDefault(field: ConfigurationField): string | undefined {
  if (field.default === undefined) return undefined;
  return Array.isArray(field.default) ? JSON.stringify(field.default) : String(field.default);
}

export function effectiveFieldValue(field: ConfigurationField, drafts: Readonly<Record<string, string>>): string {
  const draft = drafts[field.key];
  if (draft !== undefined) return draft;
  if (field.currentValue !== null) return field.currentValue;
  const defaultValue = serializedDefault(field);
  if (defaultValue !== undefined) return defaultValue;
  if (field.kind === 'select') return field.options?.[0]?.value ?? '';
  if (field.kind === 'boolean') return 'false';
  return '';
}

/**
 * Design §3.1: the web form never interprets variant branches itself. When the
 * server projects a `configurationVariants` declaration onto the fields, the
 * form feeds the stored-values projection plus the current draft through the
 * contract package's pure functions — the same implementation the server
 * runs — so switching the mode re-derives the active field set instantly,
 * without saving and without waiting for a server-computed `activeNow`.
 */
interface VariantProjection {
  readonly manifest: PluginManifest;
  readonly variants: NonNullable<ConfigurationField['configurationVariants']>;
}

export function variantProjectionOf(fields: readonly ConfigurationField[]): VariantProjection | undefined {
  const variants = fields.find((field) => field.configurationVariants)?.configurationVariants;
  if (!variants) return undefined;
  return {
    variants,
    manifest: {
      configuration: fields as unknown as readonly ContractConfigurationField[],
      configurationVariants: variants,
    } as unknown as PluginManifest,
  };
}

/**
 * Draft-scoped values: the same safe projection the server computes, overlaid
 * with unsaved drafts. Under a variant declaration an unchosen select stays
 * unchosen (no implicit first-option) and a stored secret contributes nothing
 * (the mask is not a value — the server already judged its condition into
 * `requiredNow`). Strings then go through the contract's single coercion
 * boundary so requiredness compares typed values, never `"true"` vs `true`.
 */
export function variantDraftValues(
  fields: readonly ConfigurationField[],
  drafts: Readonly<Record<string, string>>,
  manifest: PluginManifest,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'operation') continue;
    const draft = drafts[field.key];
    if (draft !== undefined) {
      // An empty draft is an explicit deletion, matching configurationUpdates:
      // the stored value contributes nothing to branch resolution or
      // requiredness. Falling back to currentValue here would keep stale
      // conditions alive after the operator cleared them. The declared
      // default still applies afterwards — the contract re-fills it — so
      // a cleared conditional falls back to its default semantics, not to
      // "no value".
      if (draft.length > 0) {
        values[field.key] = draft;
        continue;
      }
    } else if (field.currentValue !== null) {
      if (field.kind !== 'secret') values[field.key] = field.currentValue;
      continue;
    }
    const defaultValue = serializedDefault(field);
    if (defaultValue !== undefined) values[field.key] = defaultValue;
  }
  return coerceStoredValues(manifest, values);
}

/**
 * The active field set for the current draft: common fields (not claimed by
 * any branch) plus the selected branch's fields. An unselected/invalid
 * resolution activates the common fields only, mirroring the contract's
 * effective-configuration semantics.
 */
export function variantActiveKeysOf(
  fields: readonly ConfigurationField[],
  projection: VariantProjection,
  drafts: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const claimed = new Set(projection.variants.branches.flatMap((branch) => branch.fields));
  const resolution = resolveConfigurationVariant(
    projection.manifest,
    variantDraftValues(fields, drafts, projection.manifest),
  );
  const branch =
    resolution.status === 'selected'
      ? projection.variants.branches.find((item) => item.id === resolution.branchId)
      : undefined;
  return new Set([
    ...fields.filter((field) => field.kind !== 'operation' && !claimed.has(field.key)).map((field) => field.key),
    ...(branch?.fields ?? []),
  ]);
}

export function renderedFieldValue(
  field: ConfigurationField,
  drafts: Readonly<Record<string, string>>,
  variantMode: boolean,
): string {
  const draft = drafts[field.key];
  if (draft !== undefined) return draft;
  if (variantMode && field.kind === 'select') {
    // An unchosen discriminator stays unchosen: no implicit first option.
    if (field.currentValue !== null) return field.currentValue;
    return serializedDefault(field) ?? '';
  }
  if (field.kind === 'select' || field.kind === 'boolean') return effectiveFieldValue(field, drafts);
  return '';
}

export function configurationUpdates(
  fields: readonly ConfigurationField[],
  drafts: Readonly<Record<string, string>>,
  activeKeys?: ReadonlySet<string>,
  variantMode = false,
): readonly { key: string; value: string | null }[] {
  return fields
    .filter((field) => field.kind !== 'operation' && field.hidden !== true)
    .filter((field) => activeKeys === undefined || activeKeys.has(field.key))
    .flatMap((field) => {
      const draft = drafts[field.key];
      if (draft !== undefined) return [{ key: field.key, value: draft.length === 0 ? null : draft }];
      if (variantMode) return [];
      if (field.currentValue === null && field.default === undefined) {
        if (field.kind === 'select' && field.options?.[0]) {
          return [{ key: field.key, value: field.options[0].value }];
        }
        if (field.kind === 'boolean') return [{ key: field.key, value: 'false' }];
      }
      return [];
    });
}
