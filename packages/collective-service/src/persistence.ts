import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type MutableServiceState, migrateServiceState, parseServiceState, type ServiceState } from './state.js';

export const SERVICE_STATE_FILE = 'collective-service.json';

export function createStableId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll('-', '')}`;
}

export function createSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function digestSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretMatches(secret: string, digest: string): boolean {
  const actual = Buffer.from(digestSecret(secret), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PersistentServiceState {
  readonly filePath: string;
  #state: ServiceState;
  #tail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: ServiceState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async create(dataDirectory: string, state: ServiceState): Promise<PersistentServiceState> {
    const filePath = join(dataDirectory, SERVICE_STATE_FILE);
    const persistence = new PersistentServiceState(filePath, state);
    await writeAtomic(filePath, state);
    return persistence;
  }

  static async load(dataDirectory: string): Promise<PersistentServiceState> {
    const filePath = join(dataDirectory, SERVICE_STATE_FILE);
    const contents = await readFile(filePath, 'utf8');
    const migrated = migrateServiceState(JSON.parse(contents));
    if (migrated.migrated) await writeAtomic(filePath, migrated.state);
    return new PersistentServiceState(filePath, migrated.state);
  }

  snapshot(): ServiceState {
    return structuredClone(this.#state);
  }

  async transaction<T>(mutate: (draft: MutableServiceState) => T): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const draft = structuredClone(this.#state) as MutableServiceState;
      const result = mutate(draft);
      const validated = parseServiceState(draft);
      await writeAtomic(this.filePath, validated);
      this.#state = validated;
      return result;
    } finally {
      release?.();
    }
  }
}

async function writeAtomic(filePath: string, state: ServiceState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  const directoryHandle = await open(dirname(filePath), 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
