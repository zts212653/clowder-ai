import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.createReadStream;
const later = globalThis.setTimeout;
fs.createReadStream = function (path, options) {
  if (!String(path).endsWith('/output.fifo')) return original.call(this, path, options);
  return original.call(this, path, {
    ...options,
    fs: {
      open(...args) {
        later(() => fs.open(...args), 40);
      },
      read: fs.read,
      close: fs.close,
    },
  });
};
syncBuiltinESMExports();
