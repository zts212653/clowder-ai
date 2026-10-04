import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory } from '@cat-cafe/shared/node-private-fs';

export async function privateTestDirectory(prefix: string): Promise<string> {
  const path = `${prefix}${randomUUID()}`;
  await ensurePrivateDirectory(path);
  return path;
}
