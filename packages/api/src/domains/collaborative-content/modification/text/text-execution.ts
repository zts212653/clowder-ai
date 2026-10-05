import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ContentTextProposal } from '@cat-cafe/shared';
import { applyContentTextEdits, ModificationTextError, type ModificationTextSource } from './text-store.js';

/** Only isolated copies live here. The mutable workspace path is never an execution output. */
export class ModificationTextExecution {
  constructor(private readonly directory: string) {}

  async prepare(source: ModificationTextSource) {
    if (!/^f309-modification-[a-f0-9]{64}$/.test(source.requestId)) throw new ModificationTextError('not_found');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const root = await realpath(this.directory),
      executionDirectory = join(root, source.requestId);
    await mkdir(executionDirectory, { recursive: true, mode: 0o700 });
    if ((await realpath(executionDirectory)) !== executionDirectory) throw new ModificationTextError('not_found');
    const sourcePath = join(executionDirectory, `base-${basename(source.source.locator.path)}`);
    await this.immutableFile(sourcePath, source.text);
    return { executionDirectory, sourcePath };
  }

  async materialize(source: ModificationTextSource, proposal: ContentTextProposal): Promise<string> {
    const { executionDirectory } = await this.prepare(source);
    const path = join(executionDirectory, `proposal-${proposal.revision}-${basename(source.source.locator.path)}`);
    await this.immutableFile(path, applyContentTextEdits(source.text, proposal.edits));
    return path;
  }

  private async immutableFile(path: string, text: string) {
    const file = await open(path, 'wx', 0o400).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await realpath(path)) !== path || (await readFile(path, 'utf8')) !== text)
        throw new ModificationTextError('source_changed');
      return undefined;
    });
    if (!file) return;
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
