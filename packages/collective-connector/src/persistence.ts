import { randomUUID } from 'node:crypto';
import { type BigIntStats, constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  type ConnectorState,
  type MutableConnectorState,
  migrateConnectorState,
  parseConnectorState,
} from './state.js';

export const CONNECTOR_STATE_FILE = 'collective-connector.json';

export class ConnectorPersistence {
  readonly filePath: string;
  #state: ConnectorState;
  #tail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: ConnectorState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async open(dataDirectory: string): Promise<ConnectorPersistence> {
    const filePath = join(dataDirectory, CONNECTOR_STATE_FILE);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(dataDirectory);
    try {
      const contents = await readPrivateRegularFile(filePath);
      const raw = JSON.parse(contents.toString('utf8')) as unknown;
      const state = migrateConnectorState(raw);
      const persistence = new ConnectorPersistence(filePath, state);
      if (schemaVersionOf(raw) !== state.schemaVersion) await persistence.write(state);
      return persistence;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const persistence = new ConnectorPersistence(filePath, {
        schemaVersion: 2,
        connections: {},
        legacyConnections: [],
        hostRoutes: {},
      });
      await persistence.write(persistence.#state);
      return persistence;
    }
  }

  snapshot(): ConnectorState {
    return structuredClone(this.#state);
  }

  async transaction<T>(mutate: (draft: MutableConnectorState) => T): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = structuredClone(this.#state) as MutableConnectorState;
      const result = mutate(draft);
      const validated = parseConnectorState(draft);
      const serialized = serializeState(validated);
      if (serialized !== serializeState(this.#state) || !(await this.backingFileMatches(serialized)))
        await this.write(validated);
      this.#state = validated;
      return result;
    } finally {
      release?.();
    }
  }

  private async backingFileMatches(serialized: string): Promise<boolean> {
    const directory = dirname(this.filePath);
    await assertPrivateDirectory(directory);
    try {
      const bytes = await readPrivateRegularFile(this.filePath);
      await assertPrivateDirectory(directory);
      return bytes.equals(Buffer.from(serialized, 'utf8'));
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async write(state: ConnectorState): Promise<void> {
    await assertPrivateDirectory(dirname(this.filePath));
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serializeState(state), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
    const directoryHandle = await open(dirname(this.filePath), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

function serializeState(state: ConnectorState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function schemaVersionOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return undefined;
  return value.schemaVersion;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`Collective Connector data directory must be a private regular directory`);
  }
  assertOwned(metadata);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Collective Connector data directory permissions must be private (mode 0700)`);
  }
}

function assertOwned(metadata: Pick<Stats | BigIntStats, 'uid'>): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid !== undefined && Number(metadata.uid) !== uid)
    throw new Error(`Collective Connector private state must be owned by the current user`);
}

function assertPrivateRegularFile(metadata: BigIntStats): void {
  if (!metadata.isFile()) throw new Error(`Collective Connector credential state must be a private regular file`);
  assertOwned(metadata);
  if ((metadata.mode & 0o077n) !== 0n)
    throw new Error(`Collective Connector credential state permissions must be private (mode 0600)`);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readPrivateRegularFile(path: string): Promise<Buffer> {
  const pathMetadata = await lstat(path, { bigint: true });
  assertPrivateRegularFile(pathMetadata);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateRegularFile(before);
    if (!sameFile(pathMetadata, before)) throw new Error('Collective Connector private file changed before read');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const canonical = await lstat(path, { bigint: true });
    assertPrivateRegularFile(after);
    assertPrivateRegularFile(canonical);
    if (!sameFile(before, after) || !sameFile(after, canonical) || BigInt(bytes.length) !== after.size)
      throw new Error('Collective Connector private file changed during read');
    return bytes;
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  );
}
