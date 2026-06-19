/**
 * Unified Config Field Types — F240 KD-15/KD-17
 *
 * Shared by F202 Plugin Framework and F240 IM Connector Plugin Architecture.
 * YAML config files are managed independently per domain, but type definitions
 * and parsing logic are the same codebase.
 *
 * Key invariant (KD-17): all env-backed code paths (config store, env resolve,
 * envClaims, isConfigured) MUST operate on ValueConfigField[] only.
 * OperationConfigField has no envName — mixing it into env paths is a TS error.
 */

// ── Field type discriminator ────────────────────────────────────────

export type ConfigFieldType = 'input' | 'toggle' | 'select' | 'list' | 'operation';

// ── Value fields: env-backed, have envName ──────────────────────────

/** Base shape shared by all env-backed (value) config fields */
interface ValueConfigFieldBase {
  envName: string;
  label: string;
  required: boolean;
  /** Field group for UI sectioning (e.g. "permissions") */
  group?: string;
}

export interface InputConfigField extends ValueConfigFieldBase {
  type: 'input';
  sensitive: boolean;
  /** Hide from manual config UI (managed by operation target backfill) */
  hidden?: boolean;
  /** Default value (string) */
  default?: string;
  /** Conditional requirement */
  requiredWhen?: { envName: string; value: string };
}

export interface ToggleConfigField extends ValueConfigFieldBase {
  type: 'toggle';
  /** Default value — stored as "true"/"false" string in config store */
  default?: boolean;
}

export interface SelectConfigField extends ValueConfigFieldBase {
  type: 'select';
  options: { value: string; label: string }[];
  /** Default — must be one of options[].value */
  default?: string;
}

export interface ListConfigField extends ValueConfigFieldBase {
  type: 'list';
  itemLabel?: string;
  /** Default — stored as JSON string array in config store */
  default?: string[];
}

/** Union of all env-backed config field types */
export type ValueConfigField = InputConfigField | ToggleConfigField | SelectConfigField | ListConfigField;

// ── Operation fields: NOT env-backed, have name ────────────────────

export interface ActionDef {
  id: string;
  label: string;
  /** Frontend render type */
  render: 'button' | 'polling' | 'status' | string;
  /** Render type for action result data (e.g. "img") */
  resultRender?: string;
  /** Next action ID on success */
  next?: string;
  /** Action ID to rollback to on failure/timeout */
  rollback?: string;
  /** Timeout in seconds (for polling actions) */
  timeout?: number;
}

export interface OperationConfigField {
  type: 'operation';
  /** Operation name (unique within connector, used as key in _operations state) */
  name: string;
  label: string;
  required: boolean;
  /** Value field envNames to backfill on success */
  target?: string[];
  /** Action state machine chain */
  actions: ActionDef[];
}

// ── Union + type guards ─────────────────────────────────────────────

/** All config field types — manifest.config is ConfigField[] */
export type ConfigField = ValueConfigField | OperationConfigField;

/** Type guard: env-backed field with envName */
export function isValueField(field: ConfigField): field is ValueConfigField {
  return field.type !== 'operation';
}

/** Type guard: operation field with name (no envName) */
export function isOperationField(field: ConfigField): field is OperationConfigField {
  return field.type === 'operation';
}

// ── Operation state (persisted in _operations namespace) ────────────

export interface OperationState {
  currentAction: string;
  lastResult?: { render: string; data: unknown; label?: string };
  /** Epoch ms of last state write — frontend uses this with YAML `timeout` for rollback detection */
  updatedAt?: number;
}
