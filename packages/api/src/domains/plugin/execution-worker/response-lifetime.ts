import { Readable } from 'node:stream';

/** Retire only after the iterator actually transmitted by the codec is finished. */
export function retainResponseIterator(
  iterator: AsyncIterator<unknown>,
  retire: () => void,
): AsyncIterableIterator<unknown> {
  let done = false;
  const end = () => {
    if (!done) {
      done = true;
      retire();
    }
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(...args: [] | [unknown]) {
      if (done) return { done: true, value: undefined };
      try {
        const result = await iterator.next(...args);
        if (result.done) end();
        return result;
      } catch (error) {
        end();
        throw error;
      }
    },
    async return() {
      if (done) return { done: true, value: undefined };
      try {
        await iterator.return?.();
        return { done: true, value: undefined };
      } finally {
        end();
      }
    },
  };
}

/** Both codec directions own exactly the resources visited during response construction. */
export class ResponseLifetime {
  readonly #readables = new Set<Readable>();
  #pending = 0;
  #completed = false;
  #retired = false;

  constructor(private readonly retire: () => void) {}

  #retain(): () => void {
    this.#pending++;
    return () => {
      this.#pending--;
      this.#finish();
    };
  }

  #finish(): void {
    if (this.#completed && this.#pending === 0 && !this.#retired) {
      this.#retired = true;
      this.retire();
    }
  }

  readable(stream: Readable): void {
    if (this.#readables.has(stream) || stream.closed) return;
    this.#readables.add(stream);
    stream.once('close', this.#retain());
  }

  iterator(iterator: AsyncIterator<unknown>): AsyncIterableIterator<unknown> {
    return retainResponseIterator(iterator, this.#retain());
  }

  complete(): boolean {
    this.#completed = true;
    this.#finish();
    return this.#pending > 0;
  }
}
