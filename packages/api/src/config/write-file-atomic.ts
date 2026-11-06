import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

export interface WriteFileAtomicOptions {
  /** File mode for the new file (e.g. 0o600 for credentials). Omitted: the process default. */
  mode?: number;
  /** Runs on the written temp file before it replaces the target; throwing keeps the old file. */
  verify?: (tempPath: string) => void;
}

/**
 * Replace a config file atomically: write a sibling temp file, then rename it over the target.
 * A failed write, verify or rename removes the temp file and leaves the old file in place.
 */
export function writeFileAtomic(filePath: string, content: string, options: WriteFileAtomicOptions = {}): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, options.mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode: options.mode });
  try {
    options.verify?.(tempPath);
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures; the original error is what matters.
    }
    throw error;
  }
}
