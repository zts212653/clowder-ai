import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import { isDiscoverableSourcePath } from '@cat-cafe/shared/scanner-discovery-pure';
import { publishedTasteSnapshot } from '../taste/services/PublishedTasteSnapshot.js';
import { CatCafeScanner } from './CatCafeScanner.js';
import type { ScannedEvidence } from './interfaces.js';
import { gitDocumentTree, readGitBlobs, sourceGit, sourceRef } from './published-git-source.js';
import type { TasteMemoryLifecycleStore } from './taste/TasteMemoryLifecycleStore.js';

export interface PublishedDocumentSnapshot {
  revision: string;
  publicationRef: 'origin/main' | 'HEAD';
  files: Map<string, string>;
  read(path: string): Promise<string | null>;
  scan(paths?: string[]): Promise<ScannedEvidence[]>;
}

/** Publication is Git truth; the index owns only a recoverable checkpoint of it. */
export class PublishedDocumentSource {
  private readonly scanner: CatCafeScanner;
  constructor(
    readonly root: string,
    private readonly options: {
      exclude?: string[];
      lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>;
      ownerUserId?: string;
      lifecycleRevision?: () => string;
    } = {},
  ) {
    this.scanner = new CatCafeScanner(options.exclude);
  }

  addExcludePatterns(patterns: string[]): void {
    this.scanner.addExcludePatterns(patterns);
  }

  async snapshot(fetchRemote = false): Promise<PublishedDocumentSnapshot> {
    const remote = await sourceRef(this.root, 'refs/remotes/origin/main');
    if (fetchRemote && remote) {
      // Fetch only the published tracking ref. Dirty/diverged branches and the index stay untouched.
      await sourceGit(this.root, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        'main:refs/remotes/origin/main',
      ]);
    }
    const revision =
      (await sourceRef(this.root, 'refs/remotes/origin/main')) ??
      (await sourceGit(this.root, ['rev-parse', '--verify', 'HEAD'])).trim();
    const objects = await gitDocumentTree(this.root, revision);
    const taste = await publishedTasteSnapshot(this.root);
    for (const path of objects.keys()) if (path.startsWith('taste/vignettes/')) objects.delete(path);
    if (taste) {
      if (!taste.entries) throw new Error('Published Taste snapshot does not expose its source versions');
      for (const [path, oid] of await taste.entries()) {
        const rel = path.slice('docs/'.length);
        objects.set(rel, oid);
      }
    }
    for (const path of objects.keys()) {
      if (
        !isDiscoverableSourcePath(path) ||
        !this.scanner.acceptsPath(resolve(this.root, 'docs', path), resolve(this.root, 'docs'))
      )
        objects.delete(path);
    }
    const policy = this.options.lifecycleRevision?.() ?? '';
    const files = new Map(
      [...objects].map(([path, oid]) => [path, path.startsWith('taste/') ? oid + ':' + policy : oid]),
    );
    const contents = new Map<string, string>();
    const read = async (path: string): Promise<string | null> => {
      if (!files.has(path)) return null;
      let content = contents.get(path);
      if (content === undefined) {
        for await (const [, raw] of readGitBlobs(this.root, [[path, objects.get(path)!]])) content = raw;
        if (content !== undefined) contents.set(path, content);
      }
      if (content === undefined || !this.readable(path, content)) return null;
      return content;
    };
    return {
      revision: `${revision}${taste?.revision ? '+' + taste.revision : ''}:${policy}`,
      publicationRef: remote ? 'origin/main' : 'HEAD',
      files,
      read,
      scan: async (paths = [...files.keys()]) => {
        const ordinary = paths.filter((path) => objects.has(path) && !contents.has(path));
        for await (const [path, content] of readGitBlobs(
          this.root,
          ordinary.map((path) => [path, objects.get(path)!]),
        )) {
          contents.set(path, content);
        }
        const scanned: ScannedEvidence[] = [];
        for (const path of paths) {
          await yieldToIo();
          const content = await read(path);
          if (content === null) continue;
          scanned.push(
            ...this.scanner.parseContents(resolve(this.root, 'docs', path), resolve(this.root, 'docs'), content),
          );
        }
        return scanned;
      },
    };
  }

  private readable(path: string, content: string): boolean {
    if (!path.startsWith('taste/vignettes/') || !this.options.lifecycle) return true;
    const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    return (
      !!this.options.ownerUserId &&
      this.options.lifecycle.isReadable(this.options.ownerUserId, `docs/${path}`, revision)
    );
  }
}
