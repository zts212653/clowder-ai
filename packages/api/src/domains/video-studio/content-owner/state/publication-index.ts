import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contentKey, readOwnerManifests } from '../manifest-reader.js';
import type { SourcePublicationBatchLookup } from '../store.js';
import { isWorkPublicationScope } from '../types.js';
import type { ProjectContentStateV1 } from './manifest.js';

/** Candidate membership only: versions and access remain in canonical owner manifests. */
export class ContentPublicationIndex {
  private ready?: Promise<void>;
  private readonly directory: string;

  constructor(private readonly ownerRoot: string) {
    this.directory = join(dirname(ownerRoot), 'content-owner-index-v1');
  }

  async prepare(state: ProjectContentStateV1) {
    // New commits contribute membership independently of legacy discovery health.
    await this.add(state);
  }

  async references(ownerUserId: string, threadId: string) {
    await this.initialize();
    return this.readBucket(this.bucket(ownerUserId, threadId));
  }

  async sourceReferences(inputs: readonly SourcePublicationBatchLookup[]) {
    await this.initialize();
    const keys = [
      ...new Set(inputs.map((input) => JSON.stringify([input.ownerUserId, input.sourceRef, input.artifactRef]))),
    ];
    const buckets = await Promise.allSettled(
      keys.map((key) => this.readBucket(join(this.directory, 'sources', contentKey(key)))),
    );
    return [
      ...new Set(
        buckets.flatMap((result) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value;
        }),
      ),
    ];
  }

  private async readBucket(directory: string) {
    const names = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const results = await Promise.allSettled(
      names
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map(async (name) => {
          const ref = await readFile(join(directory, name), 'utf8');
          if (contentKey(ref) !== name) throw new Error('Invalid thread Work index identity');
          return ref;
        }),
    );
    return results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  private initialize() {
    this.ready ??= (async () => {
      const marker = join(this.directory, 'ready');
      const exists = await readFile(marker, 'utf8').catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (exists !== null) {
        if (exists !== '1') throw new Error('Invalid content publication index version');
        return;
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // One idempotent legacy migration. No completion marker can precede its complete canonical walk.
      for await (const state of readOwnerManifests(this.ownerRoot)) await this.add(state);
      await this.publish(marker, '1');
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private bucket(ownerUserId: string, threadId: string) {
    return join(this.directory, 'threads', contentKey(JSON.stringify([ownerUserId, threadId])));
  }

  private async add(state: ProjectContentStateV1) {
    const scope = state.publicationScope;
    if (isWorkPublicationScope(scope))
      await this.addCandidate(this.bucket(scope.ownerUserId, scope.threadId), state.contentRef);
    if (!scope?.ownerUserId) return;
    const keys = [
      ...new Set(
        state.revisions.flatMap((revision) =>
          revision.sourcePublication
            ? [
                JSON.stringify([
                  scope.ownerUserId,
                  revision.sourcePublication.sourceRef,
                  revision.sourcePublication.artifactRef,
                ]),
              ]
            : [],
        ),
      ),
    ];
    for (const key of keys) await this.addCandidate(join(this.directory, 'sources', contentKey(key)), state.contentRef);
  }

  private async addCandidate(directory: string, contentRef: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.publish(join(directory, contentKey(contentRef)), contentRef);
  }

  private async publish(target: string, value: string) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(value, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
