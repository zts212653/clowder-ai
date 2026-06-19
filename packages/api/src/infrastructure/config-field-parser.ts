/**
 * Shared Config Field Parser — F240 KD-15
 *
 * Parses raw YAML config field objects into typed ConfigField instances.
 * Used by both plugin-manifest.ts and connectors/plugins/im-connector-manifest.ts.
 *
 * Key rules:
 * - No `type` field → fallback to 'input' (data compat, KD-15)
 * - envName cannot start with '_' (reserved for _operations namespace, KD-17 P3)
 * - envName must be a valid shell variable name
 * - operation fields have `name` instead of `envName`
 */

import type {
  ActionDef,
  ConfigField,
  InputConfigField,
  ListConfigField,
  OperationConfigField,
  SelectConfigField,
  ToggleConfigField,
  ValueConfigField,
} from '@cat-cafe/shared';
import { encodeFieldValue } from '@cat-cafe/shared';

// ── Validation ──────────────────────────────────────────────────────

const ENV_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateEnvName(envName: string, context: string): void {
  if (!envName) throw new Error(`${context}: envName is required`);
  if (envName.startsWith('_')) {
    throw new Error(`Invalid envName '${envName}': cannot start with '_' (reserved for internal use)`);
  }
  if (!ENV_NAME_PATTERN.test(envName)) {
    throw new Error(`Invalid envName '${envName}': must be a valid shell variable name`);
  }
}

// ── Action parser ───────────────────────────────────────────────────

function parseAction(raw: Record<string, unknown>, context: string): ActionDef {
  const id = String(raw.id ?? '');
  if (!id) throw new Error(`${context}: action missing id`);

  const action: ActionDef = {
    id,
    label: String(raw.label ?? id),
    render: String(raw.render ?? 'button'),
  };

  if (typeof raw.resultRender === 'string') action.resultRender = raw.resultRender;
  if (typeof raw.next === 'string') action.next = raw.next;
  if (typeof raw.rollback === 'string') action.rollback = raw.rollback;
  if (typeof raw.timeout === 'number') action.timeout = raw.timeout;

  return action;
}

// ── Field parsers (per type) ────────────────────────────────────────

function parseInputField(raw: Record<string, unknown>, context: string): InputConfigField {
  const envName = String(raw.envName ?? '');
  validateEnvName(envName, context);

  const field: InputConfigField = {
    type: 'input',
    envName,
    label: String(raw.label ?? envName),
    sensitive: raw.sensitive === true,
    required: raw.required !== false,
  };

  if (raw.hidden === true) field.hidden = true;
  if (typeof raw.default === 'string') field.default = raw.default;
  if (typeof raw.group === 'string') field.group = raw.group;

  if (raw.requiredWhen && typeof raw.requiredWhen === 'object') {
    const rw = raw.requiredWhen as Record<string, unknown>;
    if (typeof rw.envName === 'string' && typeof rw.value === 'string') {
      field.requiredWhen = { envName: rw.envName, value: rw.value };
    }
  }

  return field;
}

function parseToggleField(raw: Record<string, unknown>, context: string): ToggleConfigField {
  const envName = String(raw.envName ?? '');
  validateEnvName(envName, context);

  const field: ToggleConfigField = {
    type: 'toggle',
    envName,
    label: String(raw.label ?? envName),
    required: raw.required !== false,
  };

  if (typeof raw.default === 'boolean') field.default = raw.default;
  if (typeof raw.group === 'string') field.group = raw.group;

  return field;
}

function parseSelectField(raw: Record<string, unknown>, context: string): SelectConfigField {
  const envName = String(raw.envName ?? '');
  validateEnvName(envName, context);

  const rawOptions = raw.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    throw new Error(`${context}: select field '${envName}' must have non-empty options array`);
  }

  const options = rawOptions.map((opt: Record<string, unknown>) => ({
    value: String(opt.value ?? ''),
    label: String(opt.label ?? opt.value ?? ''),
  }));

  const field: SelectConfigField = {
    type: 'select',
    envName,
    label: String(raw.label ?? envName),
    required: raw.required !== false,
    options,
  };

  if (typeof raw.default === 'string') {
    // Validate default is in options
    if (options.some((o) => o.value === raw.default)) {
      field.default = raw.default;
    }
  }
  if (typeof raw.group === 'string') field.group = raw.group;

  return field;
}

function parseListField(raw: Record<string, unknown>, context: string): ListConfigField {
  const envName = String(raw.envName ?? '');
  validateEnvName(envName, context);

  const field: ListConfigField = {
    type: 'list',
    envName,
    label: String(raw.label ?? envName),
    required: raw.required !== false,
  };

  if (typeof raw.itemLabel === 'string') field.itemLabel = raw.itemLabel;
  if (Array.isArray(raw.default)) field.default = raw.default.filter((v): v is string => typeof v === 'string');
  if (typeof raw.group === 'string') field.group = raw.group;

  return field;
}

function parseOperationField(raw: Record<string, unknown>, context: string): OperationConfigField {
  const name = String(raw.name ?? '');
  if (!name) throw new Error(`${context}: operation field missing name`);

  const rawActions = raw.actions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    throw new Error(`${context}: operation '${name}' must have non-empty actions array`);
  }

  const actions = rawActions.map((a: Record<string, unknown>, i: number) => parseAction(a, `${context}.actions[${i}]`));

  const field: OperationConfigField = {
    type: 'operation',
    name,
    label: String(raw.label ?? name),
    required: raw.required !== false,
    actions,
  };

  if (Array.isArray(raw.target)) {
    field.target = raw.target.filter((v): v is string => typeof v === 'string');
  }

  return field;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Parse a single raw config field object from YAML.
 * No `type` → fallback to 'input' (data compat).
 */
export function parseConfigField(raw: Record<string, unknown>, context = 'config'): ConfigField {
  const type = typeof raw.type === 'string' ? raw.type : 'input';

  switch (type) {
    case 'input':
      return parseInputField(raw, context);
    case 'toggle':
      return parseToggleField(raw, context);
    case 'select':
      return parseSelectField(raw, context);
    case 'list':
      return parseListField(raw, context);
    case 'operation':
      return parseOperationField(raw, context);
    default:
      throw new Error(`${context}: unknown config field type '${type}'`);
  }
}

/**
 * Parse an array of raw config field objects from YAML.
 * Returns typed ConfigField[].
 */
export function parseConfigFields(rawArray: unknown[], context = 'config'): ConfigField[] {
  return rawArray.map((raw, i) => parseConfigField(raw as Record<string, unknown>, `${context}[${i}]`));
}

/**
 * Filter to only value (env-backed) fields from a mixed ConfigField array.
 * Convenience wrapper for manifest.config.filter(isValueField).
 */
export function getValueFields(fields: readonly ConfigField[]): ValueConfigField[] {
  return fields.filter((f): f is ValueConfigField => f.type !== 'operation');
}

/**
 * Encode a field's YAML default value into string storage format.
 * Used during manifest parsing to normalize defaults.
 */
export function encodeDefault(field: ValueConfigField): string | undefined {
  if (field.default == null) return undefined;
  return encodeFieldValue(field, field.default);
}
