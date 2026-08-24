#!/usr/bin/env node

import { runNativeHost } from './native-host.mjs';

runNativeHost({ argv: process.argv.slice(2) }).catch((error) => {
  process.stderr.write(`personal Chrome native host failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
