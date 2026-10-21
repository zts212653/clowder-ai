/**
 * Owner-facing projection of a plugin's configuration fields: values are masked, operation callback
 * methods stay Host-private, and row actions are exposed only for the rows renderer (F202 W2-3 h1).
 */
import { isPluginConfigurationFieldRequired, type PluginManagerConfigField } from '@cat-cafe/shared';
import type { ConfigurationField } from '@clowder-ai/plugin-contract';
import type { OperationState } from '../operations/operation-state-machine.js';
import { effectivePluginConfigurationValue } from './plugin-configuration-values.js';

const SECRET_MASK = '••••••';

export type ContractConfigurationField = Exclude<ConfigurationField, { readonly kind: 'operation' }>;
export type ContractOperationField = Extract<ConfigurationField, { readonly kind: 'operation' }>;

type ContractOperationAction = ContractOperationField['actions'][number];
type StandaloneAction = NonNullable<PluginManagerConfigField['actions']>[number];

function standaloneAction(action: ContractOperationAction, render: StandaloneAction['render']): StandaloneAction {
  return {
    id: action.id,
    label: action.label,
    render,
    ...(action.resultRender === undefined ? {} : { resultRender: action.resultRender }),
    ...(action.next === undefined ? {} : { next: action.next }),
    ...(action.rollback === undefined ? {} : { rollback: action.rollback }),
    ...(action.timeout === undefined ? {} : { timeout: action.timeout }),
    ...(action.confirm === undefined ? {} : { confirm: action.confirm }),
  };
}

export function configFieldProjection(
  field: ContractConfigurationField,
  fields: readonly ContractConfigurationField[],
  stored: Readonly<Record<string, string>>,
): PluginManagerConfigField {
  const value = effectivePluginConfigurationValue(field, stored[field.key]);
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    ...(field.hidden === undefined ? {} : { hidden: field.hidden }),
    ...(field.requiredWhen === undefined ? {} : { requiredWhen: { ...field.requiredWhen } }),
    ...(field.requiredWhen === undefined
      ? {}
      : {
          requiredNow: isPluginConfigurationFieldRequired(field, (key) => {
            const referenced = fields.find((candidate) => candidate.key === key);
            return referenced ? effectivePluginConfigurationValue(referenced, stored[key]) : undefined;
          }),
        }),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.options === undefined ? {} : { options: field.options.map((option) => ({ ...option })) }),
    currentValue: value === undefined ? null : field.kind === 'secret' ? SECRET_MASK : value,
    sensitive: field.kind === 'secret',
  };
}

function rowActionsProjection(
  actions: ContractOperationField['actions'],
): Pick<PluginManagerConfigField, 'rowActions'> {
  const rowActions = actions
    .filter((action) => action.render === 'row')
    .map((action) => ({
      id: action.id,
      label: action.label,
      ...(action.confirm === undefined ? {} : { confirm: action.confirm }),
      ...(action.next === undefined ? {} : { next: action.next }),
    }));
  return rowActions.length === 0 ? {} : { rowActions };
}

export function operationFieldProjection(
  field: ContractOperationField,
  state: OperationState | undefined,
  fields: readonly ContractConfigurationField[],
  stored: Readonly<Record<string, string>>,
): PluginManagerConfigField {
  const byKey = new Map(fields.map((candidate) => [candidate.key, candidate]));
  return {
    key: field.key,
    label: field.label,
    kind: 'operation',
    required: field.required,
    ...(field.description === undefined ? {} : { description: field.description }),
    currentValue: null,
    sensitive: false,
    ...(field.target === undefined ? {} : { target: [...field.target] }),
    ...(field.target?.length
      ? {
          configured: field.target.every((key) => {
            const target = byKey.get(key);
            return target !== undefined && effectivePluginConfigurationValue(target, stored[key]) !== undefined;
          }),
        }
      : {}),
    // A `row` action is never a standalone button: it is only callable from a row of the same
    // operation's `rows` result, with that row's input (contract beta.24, F202 W2-3 h1 ①). The web
    // gets its label, confirmation and next step from `rowActions` instead.
    actions: field.actions.flatMap((action) =>
      action.render === 'row' ? [] : [standaloneAction(action, action.render)],
    ),
    ...rowActionsProjection(field.actions),
    ...(state === undefined ? {} : { operationState: structuredClone(state) }),
  };
}
