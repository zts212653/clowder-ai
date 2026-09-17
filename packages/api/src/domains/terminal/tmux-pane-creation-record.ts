import { mkdtempSync, readlinkSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { execTmuxClientCommand, TMUX_CLIENT_TIMEOUT_MS } from './tmux-client-command.js';
import { mutatePaneLease, type PaneLease, paneCreationCondition } from './tmux-pane-lease.js';
import { isMissingTmuxServer, tmuxServerEnvironment } from './tmux-server-environment.js';

// Files belong to the returned lease until its existing cleanup path runs.
// Object identity prevents a forged/copy lease from closing another gate.
const releases = new WeakMap<PaneLease, () => void>();
export function retainPaneCreation(lease: PaneLease, release: () => void): void {
  releases.set(lease, release);
}
export function releasePaneCreation(lease: PaneLease): void {
  releases.get(lease)?.();
  releases.delete(lease);
}

// symlink publishes the complete payload and wins the fixed slot in one syscall.
// EEXIST is an unowned successor; every other failure forbids exec of the agent.
export const PANE_CLAIM_SCRIPT = `const {symlinkSync}=require('node:fs');
(async()=>{
  try { symlinkSync(process.argv[1],process.argv[2]); }
  catch(error) {
    if(error.code==='EEXIST') return;
    const {mutatePaneLease}=await import(process.argv[3]);
    const [paneId,panePid]=process.argv[1].split('.');
    mutatePaneLease(process.argv[4],process.argv[5],{worktreeId:'',paneId,panePid,token:process.argv[6]},'terminate');
    process.exitCode=1;
  }
})().catch(()=>{process.exitCode=1})`;

function pendingClaim(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function closeEmptyGate(directory: string): boolean {
  try {
    rmdirSync(directory);
    return true;
  } catch (error) {
    if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** Own one original process receipt, never a lookup of the pane's current PID. */
export function createPaneCreationRecord(bin: string, socket: string, worktreeId: string, token: string) {
  const directory = mkdtempSync(join(tmpdir(), 'catcafe-pane-create-'));
  let receipt: PaneLease | undefined;
  return {
    directory,
    captureReceipt(stdout: unknown): PaneLease | undefined {
      const match = /^(%\d+) ([1-9]\d*)$/.exec(typeof stdout === 'string' ? stdout.trim() : '');
      if (!match?.[1] || !match[2]) return undefined;
      const parsed = Object.freeze({ worktreeId, paneId: match[1], panePid: match[2], token });
      receipt ??= parsed;
      return parsed;
    },
    async awaitStarted(lease: PaneLease, signal?: AbortSignal): Promise<void> {
      const deadline = Date.now() + TMUX_CLIENT_TIMEOUT_MS;
      let claim = pendingClaim(join(directory, 'claim'));
      while (claim === undefined) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('tmux creation did not publish its original process identity');
        await setTimeout(10);
        claim = pendingClaim(join(directory, 'claim'));
      }
      signal?.throwIfAborted();
      if (claim !== `${lease.paneId}.${lease.panePid}`)
        throw new Error('tmux creation process was replaced before claiming');
    },
    finish(succeeded: boolean): 'empty' | 'claimed' {
      // rmdir vs symlink is the cancel/publish linearization point. If empty
      // removal wins, even an in-flight late publisher cannot add a claim.
      if (closeEmptyGate(directory)) {
        if (!succeeded && receipt) mutatePaneLease(bin, socket, receipt, 'terminate');
        // A receipt may already be stale after a pre-claim respawn. Empty-gate
        // closure always requires waiting for unclaimed launchers to exit.
        return 'empty';
      }
      const closed = `${directory}-closed`;
      renameSync(directory, closed);
      try {
        if (succeeded) return 'claimed';
        const match = /^(%\d+)\.([1-9]\d*)$/.exec(readlinkSync(join(closed, 'claim')));
        if (!match?.[1] || !match[2]) throw new Error('Invalid original tmux process claim');
        const original = receipt ?? { worktreeId, paneId: match[1], panePid: match[2], token };
        mutatePaneLease(bin, socket, original, 'terminate');
        return 'claimed';
      } finally {
        rmSync(closed, { recursive: true, force: true });
      }
    },
    async awaitUnclaimedExit(): Promise<void> {
      // Empty-gate cancellation authorized no launcher to exec an agent. Wait
      // for those late launchers to finish their self-bound cleanup. This query
      // observes liveness only; no current PID is read or turned into a lease.
      const deadline = Date.now() + TMUX_CLIENT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const { stdout } = await execTmuxClientCommand(
            bin,
            [
              '-L',
              socket,
              'list-panes',
              '-a',
              '-f',
              `#{&&:${paneCreationCondition(token)},#{==:#{pane_dead},0}}`,
              '-F',
              '#{pane_id}',
            ],
            { env: tmuxServerEnvironment() },
          );
          if (!stdout.trim()) return;
        } catch (error) {
          if (isMissingTmuxServer(error)) return;
          throw error;
        }
        await setTimeout(10);
      }
      throw new Error('tmux launcher did not exit after its creation gate closed');
    },
  };
}
