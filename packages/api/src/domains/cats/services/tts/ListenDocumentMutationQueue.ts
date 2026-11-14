import type { ListenDocumentKey } from './DocumentListenRepository.js';

/** Keep a document's mutations in handler-arrival order across async preparation. */
export class ListenDocumentMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: ListenDocumentKey, operation: () => T | Promise<T>): Promise<T> {
    const id = JSON.stringify([key.userId, key.projectPath, key.relativePath]);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    // A rejected operation still releases the next mutation. Callers receive
    // the original result, including its error; only the ordering tail settles.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return result;
  }
}
