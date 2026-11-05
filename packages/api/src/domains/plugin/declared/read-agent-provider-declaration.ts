import { open } from 'node:fs/promises';

export class AgentProviderDeclarationReadError extends Error {}

/** Read bounded package data; callers resolve a verified package-local regular file first. */
export async function readDeclaration(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size > 65536) throw new AgentProviderDeclarationReadError('Agent provider declaration exceeds 64 KiB');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== size)
      throw new AgentProviderDeclarationReadError('Agent provider declaration changed while reading');
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new AgentProviderDeclarationReadError('Agent provider declaration is not valid JSON');
    }
  } finally {
    await file.close();
  }
}
