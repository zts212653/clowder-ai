import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { operationDirectory, readOutputRecord, writeOutputRecord } from './immutable-output-record.js';
import type { OutputOperation, OutputOperationStore } from './output-dispatch.js';
export class FileOutputOperations implements OutputOperationStore {
  constructor(private readonly root: string) {}
  async get(id: string): Promise<OutputOperation | undefined> {
    const directory = await operationDirectory(this.root, id);
    const revisions = (await readdir(directory)).flatMap(
      (name) => /^revision-([1-9][0-9]*)\.json$/.exec(name)?.[1] ?? [],
    );
    if (!revisions.length) return undefined;
    const revision = Math.max(...revisions.map(Number));
    const record = await readOutputRecord(join(directory, `revision-${revision}.json`));
    if (
      !record ||
      typeof record !== 'object' ||
      !('id' in record) ||
      record.id !== id ||
      !('revision' in record) ||
      record.revision !== revision
    )
      throw new Error('invalid_output_record');
    return record as OutputOperation;
  }
  async create(record: OutputOperation): Promise<boolean> {
    if (record.revision !== 1) throw new Error('invalid_output_revision');
    return writeOutputRecord(join(await operationDirectory(this.root, record.id), 'revision-1.json'), record);
  }
  async replace(revision: number, record: OutputOperation): Promise<boolean> {
    if (!Number.isSafeInteger(revision) || revision < 1 || record.revision !== revision + 1)
      throw new Error('invalid_output_revision');
    if ((await this.get(record.id))?.revision !== revision) return false;
    return writeOutputRecord(
      join(await operationDirectory(this.root, record.id), `revision-${record.revision}.json`),
      record,
    );
  }
}
