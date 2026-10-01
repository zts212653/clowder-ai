import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  ensurePrivateDirectory,
  readPrivateFile,
  writeAtomicPrivate,
  writeExclusivePrivate,
} from '@cat-cafe/shared/node-private-fs';

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

  static async create(dataDirectory: string, state: ServiceState): Promise<PersistentServiceState | undefined> {
    const filePath = join(dataDirectory, SERVICE_STATE_FILE);
    const created = await writeExclusivePrivate(filePath, `${JSON.stringify(state, null, 2)}\n`);
    return created ? new PersistentServiceState(filePath, state) : undefined;
  }

  static async load(
    dataDirectory: string,
    validate?: (state: ServiceState) => Promise<void>,
  ): Promise<PersistentServiceState> {
    const filePath = join(dataDirectory, SERVICE_STATE_FILE);
    await ensurePrivateDirectory(dataDirectory);
    const contents = await readPrivateFile(filePath);
    const migrated = migrateServiceState(JSON.parse(contents));
    await validate?.(migrated.state);
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
  await writeAtomicPrivate(filePath, `${JSON.stringify(state, null, 2)}\n`);
}
