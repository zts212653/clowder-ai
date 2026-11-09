import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { assertSecretFree, readSecretPayload } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { resolveAccountStoreTopology } from '../../../config/account-store-topology.js';

export interface PlatformInputOptions {
  projectRoot: string;
  fileRoot: string;
  credentials: readonly string[];
}
export function assertNoRequestCredential(content: string | Uint8Array, credentials: readonly string[]): void {
  const bytes = Buffer.from(content);
  if (credentials.some((key) => key && bytes.includes(Buffer.from(key))))
    throw new Error('Platform request contains a credential outside authentication');
  assertSecretFree(bytes);
}

/** The caller selects the input directory; realpath and the shared payload reader own file admission. */
export function createPlatformInputReader(options: PlatformInputOptions) {
  const topology = resolveAccountStoreTopology(options.projectRoot);
  const credentialFiles = [topology.primaryRoot, topology.legacyRoot].flatMap((root) =>
    root
      ? ['credentials.json', 'provider-profiles.secrets.local.json'].map((name) => resolve(root, '.cat-cafe', name))
      : [],
  );
  const fileRoot = realpathSync(options.fileRoot);
  let total = 0;
  const accept = (content: string | Uint8Array) => {
    total += Buffer.byteLength(content);
    if (total > 128 * 1024 * 1024) throw new Error('Platform request exceeds input limit');
    assertNoRequestCredential(content, options.credentials);
  };
  return {
    accept,
    read(path: string): Buffer {
      const resolved = realpathSync(resolve(fileRoot, path));
      const child = relative(fileRoot, resolved);
      if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child))
        throw new Error('Platform input file escapes the selected file root');
      if (/(?:^|[\\/])\.cat-cafe[\\/](?:credentials\.json|provider-profiles\.secrets\.local\.json)$/i.test(resolved))
        throw new Error('Platform input cannot be a credential store');
      const content = readSecretPayload(resolved, fileRoot, { files: credentialFiles, directories: [] });
      accept(content);
      return content;
    },
  };
}
