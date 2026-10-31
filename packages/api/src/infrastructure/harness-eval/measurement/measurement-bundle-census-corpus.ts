import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MeasurementVerdictCorpus {
  counts: Map<string, number>;
  hash: string;
  total: number;
}

export function scanMeasurementVerdictCorpus(repoRoot: string): MeasurementVerdictCorpus {
  const verdictDir = join(repoRoot, 'docs/harness-feedback/verdicts');
  const records: Array<{ domainId: string; fileName: string }> = [];
  const counts = new Map<string, number>();

  for (const entry of readdirSync(verdictDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const match = readFileSync(join(verdictDir, entry.name), 'utf8').match(/^domain_id:\s*(eval:[a-z0-9-]+)\s*$/m);
    if (!match) continue;
    records.push({ domainId: match[1], fileName: entry.name });
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }

  records.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const hashInput = records.map((record) => `${record.fileName}\0${record.domainId}`).join('\n');
  return {
    counts,
    hash: createHash('sha256').update(hashInput).digest('hex'),
    total: records.length,
  };
}
