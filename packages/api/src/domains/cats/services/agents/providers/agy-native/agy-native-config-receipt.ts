import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commonGitDirectory, credentialPathInProfile, requireRetiredCredential } from './agy-native-mcp-ownership.js';

interface ConfigReceipt {
  readonly v: 1;
  readonly sha256: string;
  readonly runtimeRoot: string;
  readonly credentialFile?: string;
}

type ArtifactKind = 'mcp' | 'guard';
const receiptPath = (home: string, kind: ArtifactKind) => join(home, `.gemini/config/.cat-cafe-${kind}-receipt.json`);
const hash = (body: string) => createHash('sha256').update(body).digest('hex');

/** Artifact ownership, never an authorization source. Current capabilities decide the next config. */
export function validateAgyNativeConfigReceipt(
  home: string,
  body: string,
  runtimeRoot: string,
  credential?: string,
  kind: ArtifactKind = 'mcp',
): boolean {
  let receipt: ConfigReceipt;
  const path = receiptPath(home, kind);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('AGY MCP receipt is not a regular host file');
    receipt = JSON.parse(readFileSync(path, 'utf8')) as ConfigReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (receipt.v !== 1 || receipt.sha256 !== hash(body) || typeof receipt.runtimeRoot !== 'string') {
    throw new Error('AGY MCP config changed outside the host materializer');
  }
  if (
    receipt.runtimeRoot !== runtimeRoot &&
    (realpathSync(receipt.runtimeRoot) !== receipt.runtimeRoot ||
      commonGitDirectory(receipt.runtimeRoot) !== commonGitDirectory(runtimeRoot))
  ) {
    throw new Error('AGY MCP binding belongs to a different repository');
  }
  if (receipt.credentialFile) {
    if (!credentialPathInProfile(home, receipt.credentialFile))
      throw new Error('AGY MCP receipt credential is outside profile');
    if (receipt.credentialFile !== credential) requireRetiredCredential(receipt.credentialFile);
  }
  return true;
}

export function writeAgyNativeConfigReceipt(
  home: string,
  body: string,
  runtimeRoot: string,
  credentialFile?: string,
  kind: ArtifactKind = 'mcp',
): void {
  writeFileSync(
    receiptPath(home, kind),
    JSON.stringify({ v: 1, sha256: hash(body), runtimeRoot, ...(credentialFile ? { credentialFile } : {}) }),
    { mode: 0o600 },
  );
}
