import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
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
      const raw = JSON.parse(contents) as unknown;
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
      await this.write(validated);
      this.#state = validated;
      return result;
    } finally {
      release?.();
    }
  }

  private async write(state: ConnectorState): Promise<void> {
    await assertPrivateDirectory(dirname(this.filePath));
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

function schemaVersionOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) return undefined;
  return value.schemaVersion;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new Error(`Collective Connector data directory must be a private regular directory: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Collective Connector data directory permissions must be private (mode 0700): ${path}`);
  }
}

async function readPrivateRegularFile(path: string): Promise<string> {
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile()) {
    throw new Error(`Collective Connector credential state must be a private regular file: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Collective Connector credential state must be a private regular file: ${path}`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`Collective Connector credential state permissions must be private (mode 0600): ${path}`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  );
}
