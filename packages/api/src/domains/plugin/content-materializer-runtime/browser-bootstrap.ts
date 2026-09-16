// The API builds with Node libraries. This closed structural type describes only
// the browser globals used by the Host-authored function serialized through CDP.
declare const Worker: new (
  url: string,
  options: { type: 'module' },
) => {
  terminate(): void;
  postMessage(value: unknown): void;
  onerror: (() => void) | null;
  onmessageerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
};

export async function runBrowserWorker(workerUrl: string, requestJson: string, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('materializer worker failed'));
    };
    worker.onmessageerror = () => {
      worker.terminate();
      reject(new Error('materializer invalid output'));
    };
    worker.onmessage = (event) => {
      worker.terminate();
      try {
        const output = JSON.stringify(event.data);
        if (
          typeof output !== 'string' ||
          output.length > limit ||
          new TextEncoder().encode(output).byteLength > limit
        ) {
          throw new Error('materializer output budget exceeded');
        }
        resolve(output);
      } catch (error) {
        reject(error);
      }
    };
    worker.postMessage(JSON.parse(requestJson));
  });
}
