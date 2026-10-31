import { unlinkSync } from 'node:fs';

export function removePreferenceWriteFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

/** Every owned resource gets a cleanup attempt, even when another attempt failed. */
export function preferenceCleanupFailures(stages: readonly { label: string; run: () => void }[]): Error[] {
  const errors: Error[] = [];
  for (const stage of stages) {
    try {
      stage.run();
    } catch (error) {
      errors.push(new Error(`Preference cleanup failed: ${stage.label}`, { cause: error }));
    }
  }
  return errors;
}

/** A secondary failure never replaces the primary cause. */
export function failAfterPreferenceCleanup(
  primary: unknown,
  stages: readonly { label: string; run: () => void }[],
): never {
  const errors = [primary, ...preferenceCleanupFailures(stages)];
  if (errors.length === 1) throw primary;
  throw new AggregateError(errors, 'Preference write failed and cleanup was incomplete', { cause: primary });
}
