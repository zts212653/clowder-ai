import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { findSystemNode, resolveWindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import type { PiSessionSlot } from './pi-session-store.js';

/** Import the already-installed Node CLI inside the writer process, with the lock acquired first. */
export function piSessionLaunch(
  command: string,
  args: string[],
  slot: PiSessionSlot,
): { command: string; args: string[] } {
  const resolved = resolveCliCommandOrBare(command);
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(resolved, args) : { command: resolved, args };
  if ('shell' in plan && plan.shell)
    throw new Error('Persistent Pi requires a resolvable Node CLI, not a shell fallback');
  let node = plan.command,
    entry = plan.args[0],
    tail = plan.args.slice(1);
  if (!/^node(?:\.exe)?$/i.test(basename(node))) {
    if (!isAbsolute(plan.command) || (!lstatSync(plan.command).isFile() && !lstatSync(plan.command).isSymbolicLink()))
      throw new Error('Persistent Pi requires an installed Node CLI entry');
    entry = realpathSync.native(plan.command);
    tail = plan.args;
    const fd = openSync(entry, 'r');
    const head = Buffer.alloc(256);
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    if (!/^#![^\r\n]*\bnode\b/.test(head.toString('utf8'))) throw new Error('Persistent Pi requires a Node CLI');
    node = findSystemNode() ?? '';
  }
  if (!node || !entry || !isAbsolute(entry) || entry.startsWith('-'))
    throw new Error('Pi Node entry could not be resolved');
  return {
    command: node,
    args: [fileURLToPath(new URL('./pi-session-runner.js', import.meta.url)), JSON.stringify(slot), entry, ...tail],
  };
}
