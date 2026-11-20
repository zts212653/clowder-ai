import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Fault injection only: run the real worker/SQLite, then hold its actual result
// after execute has finished. Earlier production diagnostic messages pass through.
const root = process.env.CAT_CAFE_TEST_MEMORY_RESULT_BARRIER;
if (root && process.send && process.argv[1]?.endsWith('/memory-process-entry.js')) {
  const send = process.send.bind(process);
  process.send = (message, ...args) => {
    if (message.type !== 'result' || !message.readWindow?.active || !existsSync(join(root, 'hold')))
      return send(message, ...args);
    writeFileSync(join(root, 'result-ready.json'), JSON.stringify({ pid: process.pid, ...message }));
    const timer = setInterval(() => {
      if (!existsSync(join(root, 'release'))) return;
      clearInterval(timer);
      send(message, ...args);
    }, 5);
    return true;
  };
}
