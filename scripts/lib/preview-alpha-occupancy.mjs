import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryFile } from './preview-alpha-recovery-evidence.mjs';

export function assertNoOtherAlphaGeneration(config, coordinates) {
  const names = readdirSync(config.stateDir);
  if (names.length > 16384) throw new Error('preview registry observation exceeds its bound');
  for (const name of names.filter((n) => /^[a-f0-9]{16}\.json$/.test(n))) {
    const path = join(config.stateDir, name);
    if (path === config.recordPath) continue;
    const other = recoveryFile(path).value;
    if (Object.values(coordinates.ports).includes(other.port) || other.command?.includes(coordinates.instance))
      throw new Error('another registered Alpha generation is active or unsettled, including pre-listener builds');
  }
}
