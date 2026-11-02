import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliTerminationController } from '../utils/CliTerminationController.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import type { RuntimeProviderProfile } from './account-resolver.js';
import { finalizeCodexAccountEnvironment } from './codex-account-environment.js';
import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';
import { resolveCodexAccountLaunch } from './codex-account-launch.js';

function credential(home: string): string | undefined {
  try {
    const raw = readFileSync(join(home, 'auth.json'), 'utf8');
    if (raw.length > 262144) return undefined;
    const auth = JSON.parse(raw) as { tokens?: { access_token?: string } };
    return auth.tokens?.access_token;
  } catch {
    return undefined;
  }
}
const renewals = new Map<string, Promise<void>>();

/** User-clicked renewal through official diagnostics. Never starts a turn or edits a binding. */
export async function renewCodexQuotaLogin(
  profile: RuntimeProviderProfile,
  cwd: string,
  command = resolveCliCommand('codex'),
): Promise<void> {
  const home = resolveCodexAccountLaunch(profile, { cwd }).credentialHome;
  const active = renewals.get(home);
  if (active) return active;
  const pending = performRenewal(profile, cwd, command);
  renewals.set(home, pending);
  try {
    await pending;
  } finally {
    if (renewals.get(home) === pending) renewals.delete(home);
  }
}
async function performRenewal(
  profile: RuntimeProviderProfile,
  cwd: string,
  command = resolveCliCommand('codex'),
): Promise<void> {
  if (!command) return; // The following quota query still reports its own outcome.
  const descriptor = resolveCodexAccountLaunch(profile, { cwd });
  const before = credential(descriptor.credentialHome);
  const identity = readCodexAccountIdentity(descriptor.credentialHome);
  if (!before || !identity) return;
  const args = ['-c', 'cli_auth_credentials_store="file"', 'doctor', '--json'];
  const overrides = finalizeCodexAccountEnvironment(descriptor, {
    env: { ...profile.envVars, HOME: process.env.HOME ?? '' },
    args,
    cwd,
  });
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: 'ignore' });
  let exited = false;
  let termination: CliTerminationController | undefined;
  const done = new Promise<void>((resolve) => {
    const finish = () => {
      exited = true;
      termination?.markExited();
      resolve();
    };
    child.once('exit', finish);
    child.once('error', finish);
  });
  termination = new CliTerminationController({
    child: {
      kill: (signal?: NodeJS.Signals | number) => {
        try {
          if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, signal);
            return true;
          }
          return child.kill(signal);
        } catch {
          return false;
        }
      },
    },
    isChildExited: () => exited,
    graces: { interruptMs: 300, terminateMs: 300 },
  });
  const deadline = Date.now() + 15000;
  try {
    while (!exited && Date.now() < deadline && credential(descriptor.credentialHome) === before) await delay(100);
  } finally {
    if (!exited) {
      termination.request('terminate-first');
      await termination.waitForCompletion();
    }
    await Promise.race([done, delay(500)]);
    termination.markExited();
  }
  if (!sameCodexIdentity(identity, readCodexAccountIdentity(descriptor.credentialHome)))
    throw new Error('quota_renewal_identity_changed');
}
