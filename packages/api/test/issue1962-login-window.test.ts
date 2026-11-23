import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

test(
  'Windows login launches hidden by default and retains a visible terminal only on explicit request',
  { skip: process.platform !== 'win32' },
  async () => {
    const original = childProcess.execFile;
    const launches: unknown[][] = [];
    childProcess.execFile = ((...args: unknown[]) => {
      launches.push(args);
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, '', '');
      return new EventEmitter();
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    try {
      for (const { openCodexLoginTerminal } of [
        await import('../src/config/codex-login-driver.js'),
        await import('../dist/config/codex-login-driver.js'),
      ]) {
        const offset = launches.length;
        await openCodexLoginTerminal('fixture command');
        const hidden = launches[offset][1] as string[];
        assert.match(hidden.join(' '), /-WindowStyle Hidden/);
        assert.doesNotMatch(hidden.join(' '), /-NoExit/);
        assert.equal((launches[offset][2] as childProcess.ExecFileOptions).windowsHide, true);
        await openCodexLoginTerminal('fixture command', true);
        const visible = launches[offset + 1][1] as string[];
        assert.match(visible.join(' '), /-WindowStyle Normal/);
        assert.match(visible.join(' '), /-NoExit/);
        const encoded = visible.join(' ').match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)?.[1];
        assert.ok(encoded);
        assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /if \(\$LASTEXITCODE -eq 0\) \{ exit \}/);
      }
    } finally {
      childProcess.execFile = original;
      syncBuiltinESMExports();
    }
  },
);
