import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-agy-query-')));
const workspace = join(root, 'workspace');
const profileHome = join(root, 'profile');
const toolHome = join(root, 'tools');
for (const path of [workspace, profileHome, toolHome]) mkdirSync(path, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
const options = { profileHome, toolHome, workspaceRoot: workspace, selfHost: () => ({ confidence: 'none' }) };
const payload = (command) => ({
  toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: workspace } },
  workspacePaths: [workspace],
});
const protectedFile = join(profileHome, '.gemini/antigravity-cli/settings.json');
const cases = [
  ['native lookup of security is data', 'command -pv security delete-keychain', 'allow'],
  ['query operands are not control-file writes', `command -v rm -rf '${profileHome}/.gemini'`, 'allow'],
  ['earlier native query survives a later pipeline', 'command -v security delete-keychain; printf safe | cat', 'allow'],
  [
    'lookup does not replace positional data',
    `set -- printf safe; command -v set -- rm -rf '${profileHome}/.gemini'; "$@"`,
    'allow',
  ],
  ['unknown executable does not crash the profile boundary', '"$UNPROVED_PROGRAM" ordinary', 'allow'],
  [
    'real positional control write stays protected',
    `set -- rm -rf '${profileHome}/.gemini'; command -v set -- printf; "$@"`,
    'deny',
  ],
  ['inquiry output stays a real write', `command -v gh > '${protectedFile}'`, 'deny'],
  [
    'function cannot hide control writes',
    `command() { shift; "$@"; }; command -pv rm -rf '${profileHome}/.gemini'`,
    'deny',
  ],
  [
    'unknown source cannot certify security lookup',
    'source /tmp/unproved; command -v security delete-keychain',
    'deny',
  ],
  ['external launcher is not a native lookup', 'env command -pv security delete-keychain', 'deny'],
  ['interpreter startup cannot certify lookup', 'sh -c "command -v security delete-keychain"', 'deny'],
  [
    'query does not discard real security parameters',
    'set -- security delete-keychain; command -v set -- printf; "$@"',
    'deny',
  ],
  ['xargs command keeps security stdin', 'printf "%s\\n" "security delete-keychain" | xargs command -v', 'deny'],
  ['xargs env keeps security stdin', 'printf "%s\\n" "security" "delete-keychain" | xargs env', 'deny'],
  ['bare xargs keeps executable stdin', 'printf "%s\\n" "security" "delete-keychain" | xargs', 'deny'],
  [
    'xargs command keeps profile target stdin',
    `printf "%s\\n" "rm -rf ${profileHome}/.gemini" | xargs command -v`,
    'deny',
  ],
  ['xargs removal keeps target stdin', `printf "%s\\n" "${profileHome}/.gemini" | xargs rm -rf`, 'deny'],
  [
    'substitution source cannot borrow outer proof',
    `command -v "$(source /tmp/unproved; command -v rm -rf ${profileHome}/.gemini)"`,
    'deny',
  ],
  [
    'substitution function cannot borrow outer proof',
    `command -v "$(command() { shift; "$@"; }; command -pv rm -rf ${profileHome}/.gemini)"`,
    'deny',
  ],
  ['substitution printf output is a write', `command -v "$(echo pwned > ${protectedFile})"`, 'deny'],
  ['substitution read program output is a write', `command -v "$(cat /dev/null > ${protectedFile})"`, 'deny'],
  ['substitution bindings keep their target', `command -v "$(DIR=${profileHome}/.gemini; rm -rf "$DIR")"`, 'deny'],
  ['substitution directory keeps its target', `command -v "$(cd ${profileHome} && rm -rf .gemini)"`, 'deny'],
  ['substitution binding keeps security execution', 'command -v "$(CMD=security; "$CMD" delete-keychain)"', 'deny'],
  ['substitution inherits outer path bindings', `DIR=${profileHome}/.gemini; command -v "$(rm -rf "$DIR")"`, 'deny'],
  ['substitution inherits positional values', `set -- rm -rf '${profileHome}/.gemini'; command -v "$("$@")"`, 'deny'],
  [
    'substitution cd inherits its path binding',
    `DIR=${profileHome}; command -v "$(cd "$DIR" && rm -rf .gemini)"`,
    'deny',
  ],
  ['quoted pipeline output remains data', 'printf "%s\\n" "security delete-keychain" | xargs printf "%s\\n"', 'allow'],
  ['substitution printed text remains data', 'command -v "$(printf "%s" "security delete-keychain")"', 'allow'],
  [
    'substitution may rebind an inherited path',
    `DIR=${profileHome}/.gemini; command -v "$(DIR=${workspace}/ordinary; rm -rf "$DIR")"`,
    'allow',
  ],
  [
    'ordinary substitution output remains available',
    `command -v "$(cat /dev/null > ${workspace}/ordinary-output)"`,
    'allow',
  ],
  [
    'substitution cannot discard parent namespace changes',
    `source /tmp/unproved; command -v "$(command -v security delete-keychain)"`,
    'deny',
  ],
  ['xargs inherits parent program bindings', 'CMD=security; printf "%s\\n" delete-keychain | xargs "$CMD"', 'deny'],
  [
    'substitution bindings stay inside their child',
    `DIR=${workspace}/ordinary; command -v "$(DIR=${profileHome}/.gemini; printf safe)"; command -v "$(rm -rf "$DIR")"`,
    'allow',
  ],
];

for (const [id, command, expected] of cases)
  test(`profile-aware AGY control: ${id}`, () => {
    assert.equal(decideAgyNativeHookPayload(payload(command), options).decision, expected, id);
  });

test('real AGY hook CLI preserves the same profile-aware query boundary', () => {
  const script = fileURLToPath(new URL('../../../scripts/agy-native-effect-guard.mjs', import.meta.url));
  for (const [id, command, expected] of cases) {
    // The executable is only the guard. No supplied shell/security command runs.
    const run = spawnSync(process.execPath, [script, toolHome, 'read-write', profileHome, workspace], {
      env: { ...process.env, HOME: toolHome, CAT_CAFE_NATIVE_TOOL_HOME: toolHome },
      input: JSON.stringify(payload(command)),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(run.status, 0, `${id}: ${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).decision, expected, `${id}: ${run.stdout}`);
  }
});
