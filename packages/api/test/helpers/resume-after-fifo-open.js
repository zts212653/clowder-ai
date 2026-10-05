import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** Keep the fixture writer alive until the production reader actually opens. */
export async function resumeAfterFifoOpen(generator, fifoPath) {
  const original = fs.createReadStream;
  let observeOpen;
  const opened = new Promise((resolve) => {
    observeOpen = resolve;
  });
  fs.createReadStream = function (path, options) {
    const stream = original.call(this, path, options);
    if (path === fifoPath) observeOpen(once(stream, 'open'));
    return stream;
  };
  syncBuiltinESMExports();
  try {
    const pending = generator.next();
    await Promise.race([
      opened,
      pending.then(() => {
        throw new Error('Generator settled before its FIFO reader opened');
      }),
    ]);
    return { pending };
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
  }
}
