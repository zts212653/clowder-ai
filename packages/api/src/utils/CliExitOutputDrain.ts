import { PassThrough, type Readable } from 'node:stream';

/** Delivers every buffered byte after a bounded post-exit read window, independently of consumer speed. */
export class CliExitOutputDrain {
  readonly stream = new PassThrough();
  private draining = false;
  private drainBytes = 0;
  private readonly maxDrainBytes = 64 * 1024 * 1024;

  constructor(private readonly source: Readable) {
    source.on('error', this.onError);
    source.pipe(this.stream);
  }

  private readonly onError = (error: Error): void => {
    this.stream.destroy(error);
  };
  private readonly onEnd = (): void => {
    this.stream.end();
  };
  private readonly onData = (chunk: Buffer | string): void => {
    this.drainBytes += Buffer.byteLength(chunk);
    if (this.drainBytes > this.maxDrainBytes) {
      this.source.pause();
      this.stream.destroy(new Error('cli_post_exit_output_limit_exceeded'));
      return;
    }
    this.stream.write(chunk);
  };

  start(): void {
    if (this.draining) return;
    this.draining = true;
    this.source.unpipe(this.stream);
    if (this.source.readableEnded) {
      this.stream.end();
      return;
    }
    this.source.on('data', this.onData);
    this.source.once('end', this.onEnd);
    this.source.resume();
  }

  finish(): void {
    if (!this.draining) return;
    this.source.pause();
    this.source.removeListener('data', this.onData);
    this.source.removeListener('end', this.onEnd);
    this.source.destroy();
    this.stream.end();
  }

  dispose(): void {
    this.source.unpipe(this.stream);
    this.source.removeListener('data', this.onData);
    this.source.removeListener('end', this.onEnd);
    this.source.removeListener('error', this.onError);
    this.stream.destroy();
  }
}
