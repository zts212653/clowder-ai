import { fileURLToPath } from 'node:url';
import { isRecord } from './native-effect-policy.mjs';

// Exact wire surface of the reviewed 962e2b4 NativeShellSafetyCommandInput.
// The reserved "local" environment ID comes from exec-server/environment.rs.
// A file URI in another executor environment is not a Host filesystem proof.
const INPUT_KEYS = new Set([
  'session_id',
  'turn_id',
  'tool_use_id',
  'hook_event_name',
  'tool_name',
  'cwd',
  'native_execution',
]);
const FACT_KEYS = new Set([
  'plan_id',
  'call_id',
  'turn_id',
  'environment_id',
  'cwd_uri',
  'argv',
  'command',
  'phase',
  'constraints',
  'fingerprint',
]);

/** Project this local executor contract into the existing shared policy input. */
export function projectLocalNativeShellPayload(input) {
  if (
    !exactKeys(input, INPUT_KEYS) ||
    input.hook_event_name !== 'NativeShellSafetyCheck' ||
    input.tool_name !== 'Bash'
  ) {
    return null;
  }
  if (!['session_id', 'turn_id', 'tool_use_id', 'cwd'].every((key) => nonemptyString(input[key]))) return null;
  const facts = input.native_execution;
  if (!exactKeys(facts, FACT_KEYS)) return null;
  if (
    !['plan_id', 'call_id', 'turn_id', 'environment_id', 'cwd_uri', 'fingerprint'].every((key) =>
      nonemptyString(facts[key]),
    )
  ) {
    return null;
  }
  if (facts.call_id !== input.tool_use_id || facts.turn_id !== input.turn_id || facts.environment_id !== 'local') {
    return null;
  }
  if (
    !['before_first_effect', 'launch'].includes(facts.phase) ||
    typeof facts.command !== 'string' ||
    !isRecord(facts.constraints)
  ) {
    return null;
  }
  if (!Array.isArray(facts.argv) || facts.argv.length === 0 || !facts.argv.every((arg) => typeof arg === 'string')) {
    return null;
  }
  const cwd = localExecutorCwd(facts.cwd_uri);
  if (cwd === null) return null;
  // Keep the legacy hook cwd and any requested workdir out of the policy input.
  // Constraints/fingerprint are bindings, never a readonly or permission grant.
  return { ...input, cwd, tool_input: { command: facts.command } };
}

function localExecutorCwd(cwdUri) {
  try {
    const uri = new URL(cwdUri);
    if (uri.protocol !== 'file:' || !cwdUri.startsWith('file://') || uri.search || uri.hash) return null;
    if (uri.hostname && uri.hostname !== 'localhost') return null;
    const cwd = fileURLToPath(uri);
    // Rust PathUri reserves a NUL namespace for opaque native path bytes.
    // Its decoded carrier cannot prove a Host coordinate or enter shared policy.
    return cwd.includes('\0') ? null : cwd;
  } catch {
    return null;
  }
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key));
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
