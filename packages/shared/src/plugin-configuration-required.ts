/** The beta.19 manifest predicate, shared by Host admission, readiness, and Console. */
export interface PluginConditionalRequirement {
  readonly required: boolean;
  readonly requiredWhen?: {
    readonly key: string;
    readonly value: string | number | boolean | readonly (string | number | boolean)[];
  };
}

/** An explicit condition takes precedence over unconditional `required`. */
export function isPluginConfigurationFieldRequired(
  field: PluginConditionalRequirement,
  effectiveValueOf: (key: string) => string | undefined,
): boolean {
  if (!field.requiredWhen) return field.required;
  const actual = effectiveValueOf(field.requiredWhen.key);
  if (actual === undefined) return false;
  const expected = Array.isArray(field.requiredWhen.value) ? field.requiredWhen.value : [field.requiredWhen.value];
  return expected.some((value) => String(value) === actual);
}
