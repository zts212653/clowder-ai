import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolveCliCommand } from '../../../../../utils/cli-resolve.js';

// Isolated F306 prototype only. This exact artifact's final-event execution and
// fail-closed contracts were independently reviewed with source 962e2b4.
// Provenance: docs/evidence/2026-10-06-f306-native-final-consumer/checkpoints.json.
// Stock and prototype both report 0.159.0; a version is not capability evidence.
const REVIEWED_NATIVE_SHELL_CLI_SHA256 = '05d334f317ffcffd6da820c810822e56dfafa3537fbc4f642a1a297823592798';

export async function verifyReviewedNativeShellCli(command: string): Promise<string> {
  try {
    const resolved = resolveCliCommand(command);
    if (!resolved) throw new Error('executable_not_found');
    const path = await realpath(resolved);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== REVIEWED_NATIVE_SHELL_CLI_SHA256) throw new Error('artifact_mismatch');
    // Carry this same canonical executable into all launch transports; do not
    // resolve PATH a second time after selecting final hooks.
    return path;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`native_shell_guard_unapproved_cli:${reason}`);
  }
}
