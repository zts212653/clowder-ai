/**
 * Client descriptor registry invariants.
 *
 * These are the guards that keep the "single source of truth" claim honest. Each one
 * caught (or would have caught) a real drift that existed before the registry:
 * the detection specs were missing `agy`, and three separate clientId whitelists
 * disagreed on which clients exist.
 */

import { describe, expect, it } from 'vitest';
import type { ClientId } from '../types/cat.js';
import {
  CLIENT_DESCRIPTORS,
  CLIENT_IDS,
  CREATABLE_CLIENT_IDS,
  creatableClientIds,
  defaultCliForClient,
  formatInstallHint,
  getClientDescriptor,
  getClientDescriptorByCommand,
  installHintForCommand,
  localCliClientIds,
} from '../types/client-descriptor.js';

/** Every member of the ClientId union. Kept literal so a new ClientId fails this test. */
const ALL_CLIENT_IDS: readonly ClientId[] = [
  'anthropic',
  'openai',
  'google',
  'kimi',
  'antigravity',
  'opencode',
  'a2a',
  'catagent',
  'acp',
];

describe('client descriptor registry', () => {
  it('covers every ClientId exactly once', () => {
    const descriptorIds = CLIENT_DESCRIPTORS.map((d) => d.clientId).sort();
    expect(descriptorIds).toEqual([...ALL_CLIENT_IDS].sort());
    expect(new Set(descriptorIds).size).toBe(descriptorIds.length);
    // CLIENT_IDS is the const tuple other packages derive enums from — keep it aligned.
    expect([...CLIENT_IDS].sort()).toEqual([...ALL_CLIENT_IDS].sort());
  });

  it('never lets two descriptors claim the same binary name', () => {
    const seen = new Map<string, string>();
    for (const descriptor of CLIENT_DESCRIPTORS) {
      for (const command of descriptor.commands) {
        const owner = seen.get(command);
        expect(owner, `command "${command}" claimed by both ${owner} and ${descriptor.clientId}`).toBeUndefined();
        seen.set(command, descriptor.clientId);
      }
    }
  });

  it('keeps localCli, commands and probe strategy mutually consistent', () => {
    for (const descriptor of CLIENT_DESCRIPTORS) {
      if (descriptor.localCli) {
        expect(descriptor.commands.length, `${descriptor.clientId} is local but has no commands`).toBeGreaterThan(0);
        expect(descriptor.toolId, `${descriptor.clientId} is local but has no toolId`).not.toBeNull();
      } else {
        expect(descriptor.commands, `${descriptor.clientId} has no local CLI but lists commands`).toEqual([]);
        expect(descriptor.toolId, `${descriptor.clientId} has no local CLI but claims a toolId`).toBeNull();
      }
      if (descriptor.probe.strategy === 'path+version') {
        expect(
          descriptor.probe.versionArgs,
          `${descriptor.clientId} opted into version probing without versionArgs`,
        ).toBeDefined();
      } else {
        expect(descriptor.probe.versionArgs).toBeUndefined();
      }
    }
  });

  it('never spawns an agent runtime for detection unless explicitly whitelisted (LL-055)', () => {
    // LL-055: `opencode version` boots a full agent process, ignores SIGTERM, and leaves an
    // orphan burning CPU. Only CLIs with a documented lightweight `--version` may opt in.
    const versionProbing = CLIENT_DESCRIPTORS.filter((d) => d.probe.strategy === 'path+version').map((d) => d.clientId);
    expect(versionProbing.sort()).toEqual(['anthropic', 'openai']);
    for (const descriptor of CLIENT_DESCRIPTORS) {
      if (descriptor.probe.strategy === 'path+version') continue;
      expect(descriptor.probe.versionArgs).toBeUndefined();
    }
  });

  it('resolves every command a real call site reports to formatCliNotFoundError', () => {
    // These are the exact command strings passed from the agent services today.
    const reported = ['claude', 'codex', 'gemini', 'agy', 'kimi', 'kimi-cli', 'opencode'];
    for (const command of reported) {
      expect(getClientDescriptorByCommand(command), `no descriptor claims command "${command}"`).toBeDefined();
    }
    expect(getClientDescriptorByCommand('definitely-not-a-cli')).toBeUndefined();
  });

  it('preserves the historical default cli block for every clientId', () => {
    const expected: Record<ClientId, { command: string; outputFormat: string }> = {
      anthropic: { command: 'claude', outputFormat: 'stream-json' },
      openai: { command: 'codex', outputFormat: 'json' },
      google: { command: 'agy', outputFormat: 'plainText' },
      kimi: { command: 'kimi', outputFormat: 'stream-json' },
      opencode: { command: 'opencode', outputFormat: 'json' },
      antigravity: { command: 'antigravity', outputFormat: 'json' },
      a2a: { command: 'a2a', outputFormat: 'json' },
      catagent: { command: 'catagent', outputFormat: 'json' },
      acp: { command: 'acp', outputFormat: 'json' },
    };
    for (const clientId of ALL_CLIENT_IDS) {
      expect(defaultCliForClient(clientId), `default cli drifted for ${clientId}`).toEqual(expected[clientId]);
    }
  });

  it('falls back to the bare clientId for an unrecognised client (hand-edited catalogs)', () => {
    expect(defaultCliForClient('some-future-client')).toEqual({
      command: 'some-future-client',
      outputFormat: 'json',
    });
  });

  it('keeps the creatable set aligned with what POST /api/cats accepted before', () => {
    // Regression guard: the write schema accepted these eight. a2a is intentionally out —
    // it needs CAT_<ID>_A2A_URL before it can be routed, so creating one from the member
    // editor would produce a permanently unroutable member.
    expect([...creatableClientIds()].sort()).toEqual([
      'acp',
      'anthropic',
      'antigravity',
      'catagent',
      'google',
      'kimi',
      'openai',
      'opencode',
    ]);
    expect(creatableClientIds()).not.toContain('a2a');
    // The literal tuple exists so routes can build a *typed* zod enum from it; it must not
    // drift from the descriptor flags.
    expect([...CREATABLE_CLIENT_IDS].sort()).toEqual([...creatableClientIds()].sort());
  });

  it('derives the local-CLI probe set from localCli only', () => {
    const local = localCliClientIds();
    expect([...local].sort()).toEqual(['anthropic', 'google', 'kimi', 'openai', 'opencode']);
    expect(local).not.toContain('antigravity');
    expect(local).not.toContain('acp');
  });

  it('renders the platform-specific install hint', () => {
    const google = getClientDescriptor('google');
    expect(google).toBeDefined();
    if (!google) return;
    expect(formatInstallHint(google, 'win32')).toContain('install.cmd');
    expect(formatInstallHint(google, 'darwin')).toContain('install.sh');
    expect(formatInstallHint(google, 'linux')).toContain('install.sh');

    // A descriptor without a win32 variant falls back to the default hint.
    const anthropic = getClientDescriptor('anthropic');
    expect(anthropic).toBeDefined();
    if (!anthropic) return;
    expect(formatInstallHint(anthropic, 'win32')).toBe(anthropic.installHint.default);
  });

  it('exposes a path override env var for every local CLI', () => {
    for (const descriptor of CLIENT_DESCRIPTORS) {
      if (!descriptor.localCli) continue;
      expect(descriptor.pathEnvVar, `${descriptor.clientId} has no pathEnvVar escape hatch`).toMatch(
        /^CAT_[A-Z_]+_PATH$/,
      );
    }
  });

  it('preserves the exact install hints the legacy cli-resolve table produced', () => {
    // Parity guard: these strings are user-facing and were hardcoded before the registry.
    // `gemini` must keep its own hint rather than inheriting `agy`'s (hence altInstallHints).
    expect(installHintForCommand('claude', 'linux')).toBe('npm install -g @anthropic-ai/claude-code');
    expect(installHintForCommand('codex', 'linux')).toBe('npm install -g @openai/codex');
    expect(installHintForCommand('gemini', 'linux')).toBe('npm install -g @google/gemini-cli');
    expect(installHintForCommand('opencode', 'linux')).toBe('npm install -g opencode-ai');
    expect(installHintForCommand('agy', 'linux')).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(installHintForCommand('agy', 'win32')).toContain('install.cmd');
    expect(installHintForCommand('kimi', 'win32')).toContain('install.ps1');
    expect(installHintForCommand('kimi', 'linux')).toContain('install.sh');
    // kimi-cli shares the kimi install hint — an improvement over the old generic fallback.
    expect(installHintForCommand('kimi-cli', 'linux')).toBe(installHintForCommand('kimi', 'linux'));
    // Unknown commands stay undefined so the caller keeps its own fallback text.
    expect(installHintForCommand('definitely-not-a-cli', 'linux')).toBeUndefined();
  });
});
