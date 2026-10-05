import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { resolveActiveProjectRoot } from '../../../utils/active-project-root.js';
import { durableIdForCanonicalRoot } from '../workspace-worktree-identity.js';

const rootSchema = z
  .object({
    id: z
      .string()
      .regex(/^f063_root_v1_[a-f0-9]{64}$/)
      .optional(),
    legacyAliases: z.array(z.string().min(1)).optional(),
    name: z.string().min(1),
    path: z
      .string()
      .min(1)
      .refine((path) => isAbsolute(path) && !path.includes('\0')),
  })
  .refine(
    (entry) => !entry.id || entry.id === durableIdForCanonicalRoot(entry.path),
    'Root identity does not match its stored canonical path',
  );
export const rootConnectionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absolute-file'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('directory-selection') }).strict(),
]);
export type RootConnectionSource = z.infer<typeof rootConnectionSourceSchema>;
const operationSchema = z.object({
  receiptRef: z.string().min(1),
  userId: z.string().min(1),
  operationId: z.string().min(1),
  requestedRoot: z.string().min(1),
  root: z.string().min(1),
  rootId: z.string().min(1),
  name: z.string().min(1),
  expectedEpoch: z.number().int().nonnegative(),
  admission: z.literal('absolute-file-directory').optional(),
  source: rootConnectionSourceSchema.optional(),
});
const stateSchema = z.object({
  v: z.literal(2),
  roots: z.array(rootSchema),
  operations: z.array(operationSchema),
  rootEpochs: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type LinkedRootState = z.infer<typeof stateSchema>;
export type RootConnectionReceipt = z.infer<typeof operationSchema>;

/** Matching a new explicit grant is not the weak-alias uniqueness/authorization lookup. */
export function findLinkedRootAt(state: LinkedRootState, canonicalRoot: string) {
  const id = durableIdForCanonicalRoot(canonicalRoot);
  return state.roots.find((entry) => {
    if (entry.id) return entry.id === id;
    try {
      return realpathSync(entry.path) === canonicalRoot;
    } catch {
      // Keep unavailable legacy rows intact. They cannot identify the freshly
      // verified target; the new grant does not revive or rewrite those rows.
      return false;
    }
  });
}
export const linkedRootConfigPath = () =>
  join(
    process.env.CAT_CAFE_DATA_DIR ?? join(resolveActiveProjectRoot(), '.cat-cafe'),
    'workspace',
    'linked-roots.json',
  );

/** Old arrays remain readable. Migration happens only in an explicitly requested mutation. */
function readAt(path: string): LinkedRootState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  return stateSchema.parse(Array.isArray(parsed) ? { v: 2, roots: parsed, operations: [] } : parsed);
}

export function readLinkedRootState(): LinkedRootState {
  // Legacy config is read-only. Once a supported mutation commits, the stable
  // owner file (including an empty roots list) wins; old rows cannot reappear.
  return (
    readAt(linkedRootConfigPath()) ??
    readAt(resolve(process.cwd(), '.cat-cafe', 'linked-roots.json')) ?? {
      v: 2,
      roots: [],
      operations: [],
      rootEpochs: {},
    }
  );
}

function writeState(path: string, state: LinkedRootState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** SQLite is only a cross-process mutex; JSON remains the single root/receipt store. */
export function mutateLinkedRootState<T>(change: (state: LinkedRootState) => { value: T; changed: boolean }): T {
  const path = linkedRootConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const mutex = new Database(`${path}.mutex.sqlite`);
  try {
    mutex.pragma('busy_timeout = 5000');
    return mutex
      .transaction(() => {
        const state = readLinkedRootState();
        const result = change(state);
        if (result.changed) writeState(path, stateSchema.parse(state));
        return result.value;
      })
      .immediate();
  } finally {
    mutex.close();
  }
}

export const canonicalLinkedRootId = durableIdForCanonicalRoot;

export function rootConnectionReceiptRef(userId: string, operationId: string): string {
  return `workspace-root-connection:${createHash('sha256')
    .update(JSON.stringify([userId, operationId]))
    .digest('hex')}`;
}
