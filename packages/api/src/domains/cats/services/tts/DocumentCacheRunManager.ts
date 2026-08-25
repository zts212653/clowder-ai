import type { ListenDocumentIdentity, ListenDocumentState } from '@cat-cafe/shared';
import type { DocumentListenRepository, ListenDocumentKey } from './DocumentListenRepository.js';
import type { ListenAssetService, ListenSynthesisOptions } from './ListenAssetService.js';

export interface EphemeralListenSentence {
  anchor: string;
  text: string;
}

export interface DocumentCacheRunProjection {
  active: boolean;
  error?: string;
}

interface ActiveRun {
  key: ListenDocumentKey;
  contentDigest: string;
  synthesisFingerprint: string;
  sentences: EphemeralListenSentence[];
  controller: AbortController;
}

interface RunError {
  contentDigest: string;
  synthesisFingerprint: string;
  message: string;
}

export class DocumentCacheRunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly errors = new Map<string, RunError>();

  constructor(
    private readonly repository: DocumentListenRepository,
    private readonly assets: ListenAssetService,
  ) {}

  start(input: {
    key: ListenDocumentKey;
    identity: ListenDocumentIdentity;
    sentences: EphemeralListenSentence[];
    synthesis?: ListenSynthesisOptions;
    startAnchor?: string;
  }): DocumentCacheRunProjection {
    const synthesisFingerprint = this.assets.getSynthesisFingerprint(input.synthesis);
    this.repository.prepareCacheRun(
      input.key,
      input.identity.contentDigest,
      synthesisFingerprint,
      input.sentences.map(({ anchor }) => anchor),
    );
    const documentKey = keyOf(input.key);
    const existing = this.runs.get(documentKey);
    if (
      existing &&
      existing.contentDigest === input.identity.contentDigest &&
      existing.synthesisFingerprint === synthesisFingerprint
    ) {
      return { active: true };
    }
    this.cancelByKey(documentKey);
    this.errors.delete(documentKey);
    const state = this.repository.loadDocument(input.key);
    if (isComplete(state)) return { active: false };

    const run: ActiveRun = {
      key: input.key,
      contentDigest: input.identity.contentDigest,
      synthesisFingerprint,
      sentences: orderedFrom(input.sentences, input.startAnchor),
      controller: new AbortController(),
    };
    this.runs.set(documentKey, run);
    void this.advance(documentKey, run, input.synthesis);
    return { active: true };
  }

  cancel(key: ListenDocumentKey, expected?: { contentDigest: string; synthesisFingerprint: string }): boolean {
    const documentKey = keyOf(key);
    const run = this.runs.get(documentKey);
    if (
      expected &&
      run &&
      (run.contentDigest !== expected.contentDigest || run.synthesisFingerprint !== expected.synthesisFingerprint)
    ) {
      return false;
    }
    return this.cancelByKey(documentKey);
  }

  invalidateStale(key: ListenDocumentKey, state: ListenDocumentState): void {
    const documentKey = keyOf(key);
    const run = this.runs.get(documentKey);
    if (
      run &&
      (run.contentDigest !== state.identity.contentDigest ||
        run.synthesisFingerprint !== (state.synthesisFingerprint ?? ''))
    ) {
      this.cancelByKey(documentKey);
    }
    const error = this.errors.get(documentKey);
    if (
      error &&
      (error.contentDigest !== state.identity.contentDigest ||
        error.synthesisFingerprint !== (state.synthesisFingerprint ?? ''))
    ) {
      this.errors.delete(documentKey);
    }
  }

  status(key: ListenDocumentKey, state: ListenDocumentState): DocumentCacheRunProjection {
    const documentKey = keyOf(key);
    const run = this.runs.get(documentKey);
    if (
      run &&
      run.contentDigest === state.identity.contentDigest &&
      run.synthesisFingerprint === (state.synthesisFingerprint ?? '')
    ) {
      return { active: true };
    }
    const error = this.errors.get(documentKey);
    if (
      error &&
      error.contentDigest === state.identity.contentDigest &&
      error.synthesisFingerprint === (state.synthesisFingerprint ?? '')
    ) {
      return { active: false, error: error.message };
    }
    return { active: false };
  }

  close(): void {
    for (const documentKey of this.runs.keys()) this.cancelByKey(documentKey);
    this.errors.clear();
  }

  private async advance(documentKey: string, run: ActiveRun, synthesis?: ListenSynthesisOptions): Promise<void> {
    try {
      for (const sentence of run.sentences) {
        if (!(await this.cacheSentence(documentKey, run, sentence, synthesis))) return;
      }
    } catch (error) {
      this.recordError(documentKey, run, error);
    } finally {
      if (this.runs.get(documentKey) === run) this.runs.delete(documentKey);
    }
  }

  private async cacheSentence(
    documentKey: string,
    run: ActiveRun,
    sentence: EphemeralListenSentence,
    synthesis?: ListenSynthesisOptions,
  ): Promise<boolean> {
    if (!this.isCurrent(documentKey, run)) return false;
    const state = this.repository.loadDocument(run.key);
    if (state?.sentences.some(({ anchor, assetId }) => anchor === sentence.anchor && assetId)) return true;
    const asset = await this.assets.getOrCreate(sentence.text, { synthesis, signal: run.controller.signal });
    if (!this.isCurrent(documentKey, run)) return false;
    const linked = this.repository.setSentenceAssetIfCurrent(run.key, {
      contentDigest: run.contentDigest,
      synthesisFingerprint: run.synthesisFingerprint,
      anchor: sentence.anchor,
      assetId: asset.assetId,
    });
    if (!linked) return false;
    // The provider's existing single worker arbitrates real synthesis. Yield at
    // a sentence boundary so a playback miss can join before another cache miss.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return true;
  }

  private recordError(documentKey: string, run: ActiveRun, error: unknown): void {
    if (run.controller.signal.aborted || !this.isCurrent(documentKey, run)) return;
    this.errors.set(documentKey, {
      contentDigest: run.contentDigest,
      synthesisFingerprint: run.synthesisFingerprint,
      message: error instanceof Error ? error.message : '全文缓存失败',
    });
  }

  private isCurrent(documentKey: string, run: ActiveRun): boolean {
    return this.runs.get(documentKey) === run && !run.controller.signal.aborted;
  }

  private cancelByKey(documentKey: string): boolean {
    const run = this.runs.get(documentKey);
    if (!run) return false;
    this.runs.delete(documentKey);
    run.controller.abort();
    this.errors.delete(documentKey);
    return true;
  }
}

function keyOf(key: ListenDocumentKey): string {
  return JSON.stringify([key.userId, key.projectPath, key.relativePath]);
}

function isComplete(state: ListenDocumentState | null): boolean {
  return Boolean(state && state.sentences.length > 0 && state.sentences.every(({ assetId }) => assetId));
}

function orderedFrom(sentences: EphemeralListenSentence[], startAnchor?: string): EphemeralListenSentence[] {
  const index = startAnchor ? sentences.findIndex(({ anchor }) => anchor === startAnchor) : -1;
  return index > 0 ? [...sentences.slice(index), ...sentences.slice(0, index)] : [...sentences];
}
