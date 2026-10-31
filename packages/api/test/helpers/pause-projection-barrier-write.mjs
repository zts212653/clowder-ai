// Preload only in the regression probe: stop a real child between file creation and payload write.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [, , , , paused, , , writeReleased] = process.argv;
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  if (typeof path !== 'string' || !(path === paused || path.startsWith(`${paused}.`))) {
    return writeFileSync(path, data, options);
  }
  const fd = fs.openSync(path, 'w');
  try {
    process.send({ phase: 'barrier_file_opened' });
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(writeReleased)) {
      if (Date.now() > deadline) throw new Error('Barrier write probe was not released');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return writeFileSync(fd, data, options);
  } finally {
    fs.closeSync(fd);
  }
};
syncBuiltinESMExports();
