import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEntry, AuditSink } from './AntigravityToolExecutor.js';

export class AuditLogger implements AuditSink {
  constructor(private readonly logDir: string) {
    mkdirSync(logDir, { recursive: true });
  }

  async record(entry: AuditEntry): Promise<void> {
    const date = entry.timestamp.toISOString().slice(0, 10);
    const file = join(this.logDir, `native-audit-${date}.jsonl`);
    const serialized = JSON.stringify({
      tool: entry.tool,
      cascadeId: entry.cascadeId,
      stepIndex: entry.stepIndex,
      input: entry.input,
      result: entry.result,
      timestamp: entry.timestamp.toISOString(),
    });
    appendFileSync(file, `${serialized}\n`);
  }
}
