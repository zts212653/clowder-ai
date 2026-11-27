/** Provider-neutral marker inherited by commands launched inside a cat CLI process tree. */
export const CLI_PROCESS_OWNER_ENV = 'CAT_CAFE_PROCESS_OWNER_ID';

/** Non-sensitive carrier context shared by cat CLI processes without encoding identity. */
export const CLI_PROCESS_CONTEXT_ENV = 'CAT_CAFE_CLI_PROCESS_CONTEXT';
export const CAT_CLI_PROCESS_CONTEXT = 'cat';

export function withCatCliProcessContext<T extends Record<string, string | null | undefined>>(environment: T) {
  return { ...environment, [CLI_PROCESS_CONTEXT_ENV]: CAT_CLI_PROCESS_CONTEXT };
}

/**
 * Environment for process-table reads. `ps -o lstart` is locale-formatted, so the
 * start-time identity text is only comparable when every read uses the C locale.
 */
export function processTableEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, LC_ALL: 'C' };
}
