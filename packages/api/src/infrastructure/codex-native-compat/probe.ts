import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Check, CheckFailed, type Socket } from './probe-check.js';
import type { ProbeHost } from './probe-host.js';
import { probeManagedAccounts } from './probe-managed.js';
import { probeReadonlySandbox } from './probe-readonly.js';

/** Bump when the checks change, so verdicts recorded by an older probe are measured again. */
export const CODEX_COMPAT_PROBE_REVISION = 1;
export type CodexNativeCapability = 'managed_accounts' | 'readonly_sandbox';
export interface CodexCompatCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail?: string;
}
export interface CodexCompatReport {
  readonly capability: CodexNativeCapability;
  readonly version: string;
  readonly probeRevision: number;
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly checks: readonly CodexCompatCheck[];
}

const PROBE_DEADLINE_MS = 120_000;

/** Credential-free measurement of one capability on the installed binary. Never touches real homes. */
export async function probeCodexNativeCapability(
  binary: string,
  capability: CodexNativeCapability,
  version: string,
): Promise<CodexCompatReport> {
  const checks: CodexCompatCheck[] = [];
  const hosts: ProbeHost[] = [];
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-cafe-codex-compat-')));
  // Unix socket paths are capped at 104 bytes on macOS; the per-user TMPDIR is too deep for them.
  const sockets = await mkdtemp('/tmp/cc-compat-');
  let socketCount = 0;
  const socket: Socket = () => join(sockets, `${++socketCount}.sock`);
  const check: Check = async (id, assertion) => {
    try {
      await assertion();
      checks.push({ id, ok: true });
    } catch (error) {
      checks.push({ id, ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      throw new CheckFailed(id);
    }
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const body =
      capability === 'managed_accounts'
        ? probeManagedAccounts(binary, root, socket, check, hosts)
        : probeReadonlySandbox(binary, root, socket, check, hosts);
    await Promise.race([
      body,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('codex_probe_deadline')), PROBE_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    // A failed check is already recorded; anything else is the probe itself failing to complete.
    if (!(error instanceof CheckFailed))
      checks.push({
        id: 'probe.completed',
        ok: false,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
  } finally {
    if (deadline) clearTimeout(deadline);
    await Promise.allSettled(hosts.map((host) => host.stop()));
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(sockets, { recursive: true, force: true }).catch(() => {});
  }
  return {
    capability,
    version,
    probeRevision: CODEX_COMPAT_PROBE_REVISION,
    checkedAt: new Date().toISOString(),
    ok: checks.length > 0 && checks.every((entry) => entry.ok),
    checks,
  };
}
