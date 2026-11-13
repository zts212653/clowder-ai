import { AsyncLocalStorage } from 'node:async_hooks';

const referenceReads = new AsyncLocalStorage<{ values: Map<string, string | undefined>; changed: boolean }>();
const invocationOverrides = new AsyncLocalStorage<Readonly<Record<string, string>>>();

/** The admitted account/member environment is shared by all MCP projections for this invocation. */
export function withEnvironmentReferenceOverrides<T>(overrides: Readonly<Record<string, string>>, capture: () => T): T {
  return invocationOverrides.run(overrides, capture);
}

/** Admission-local observation only; the environment remains the sole source. No values are persisted. */
export async function captureEnvironmentReferences<T>(capture: () => T | Promise<T>) {
  const state = { values: new Map<string, string | undefined>(), changed: false };
  const value = await referenceReads.run(state, capture);
  return {
    value,
    isCurrent: () => !state.changed && [...state.values].every(([key, value]) => process.env[key] === value),
  };
}

/** Expand ordinary ${NAME} references once, without recursively interpreting secret values as templates. */
export function resolveEnvReferences(
  values: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: { hostOnly?: boolean } = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\$\{([^}]+)\}/g, (_reference, name: string) => {
        const overrides = environment === process.env && !options.hostOnly ? invocationOverrides.getStore() : undefined;
        const overridden = overrides !== undefined && Object.hasOwn(overrides, name);
        const value = overridden ? overrides[name] : environment[name];
        const state = environment === process.env && !overridden ? referenceReads.getStore() : undefined;
        if (state) {
          if (state.values.has(name) && state.values.get(name) !== value) state.changed = true;
          else state.values.set(name, value);
        }
        return value ?? '';
      }),
    ]),
  );
}
