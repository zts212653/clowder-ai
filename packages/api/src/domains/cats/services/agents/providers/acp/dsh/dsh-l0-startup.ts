import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import { serializeDshDesktopL0Patch } from '../../../../../../../utils/dsh-desktop-launch.js';
import type { AcpPoolClient, AcpPoolStartup } from '../AcpProcessPool.js';

const log = createModuleLogger('dsh-l0-startup');

export interface DshL0Patch {
  readonly path: string;
  verify(args: readonly string[]): void;
}

export function createDshL0Startup(input: {
  body: string;
  cwd(): string;
  assertLaunch(): boolean;
  createClient(patch: DshL0Patch): AcpPoolClient;
}): AcpPoolStartup {
  const content = serializeDshDesktopL0Patch(input.body);
  return {
    revision: createHash('sha256').update(content).digest('hex'),
    async createInitializedClient() {
      if (!input.assertLaunch()) throw new Error('DSH Desktop L0 launch changed; refresh this member before retrying.');
      const path = join(input.cwd(), `dsh-l0-${randomUUID()}.patch.json`);
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      let client: AcpPoolClient | undefined;
      try {
        client = input.createClient({
          path,
          verify(args) {
            const file = lstatSync(path);
            if (
              args.at(-2) !== '--patch' ||
              args.at(-1) !== path ||
              !file.isFile() ||
              file.nlink !== 1 ||
              readFileSync(path, 'utf8') !== content
            )
              throw new Error('DSH Desktop L0 startup patch changed');
          },
        });
        await client.initialize();
        return client;
      } catch (error) {
        await client?.close().catch(() => {});
        throw error;
      } finally {
        // The desktop reads the patch during startup. Keep live-role content
        // off disk once ACP initialize has completed.
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') log.warn({ code: error.code }, 'DSH Desktop L0 startup patch cleanup failed');
        });
      }
    },
  };
}
