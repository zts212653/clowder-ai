import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapabilityAuditEntry } from '@cat-cafe/shared';

const AUDIT_DIR = '.cat-cafe';
const AUDIT_FILE = 'audit.jsonl';

export async function appendAuditEntry(projectRoot: string, entry: CapabilityAuditEntry): Promise<void> {
  const dir = join(projectRoot, AUDIT_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, AUDIT_FILE);
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export async function readAuditLog(projectRoot: string, limit = 100): Promise<CapabilityAuditEntry[]> {
  const filePath = join(projectRoot, AUDIT_DIR, AUDIT_FILE);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as CapabilityAuditEntry);
  } catch {
    return [];
  }
}
