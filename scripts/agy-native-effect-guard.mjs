#!/usr/bin/env node
// F325: only the AGY wire vocabulary lives here. Target decisions remain F306's.
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandTouchesAgyControl } from './agy-native-control-commands.mjs';
import { readSelfHostFacet } from './lib/self-host-facet.mjs';
import { kernelPath } from './lib/shell-directory.mjs';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';

const vocabulary = JSON.parse(
  readFileSync(new URL('../assets/agy-native-tool-vocabulary.json', import.meta.url), 'utf8'),
);
const FILE_WRITERS = new Set(vocabulary.fileWriters);
const COMMANDS = new Set(vocabulary.commands);
const DELEGATED_TOOLS = new Set(vocabulary.delegatedTools);
const READERS = new Set(vocabulary.readOnlyComponents);
const CONTROL_ENTRIES = new Set(['hooks.json', 'mcp_config.json', 'agents', 'plugins', 'skills.json']);

function profileControlPath(path, profileHome) {
  if (!profileHome) return false;
  const roots = [resolve(profileHome), kernelPath(profileHome)].filter(Boolean).map((root) => root.toLowerCase());
  if (roots.includes(path)) return true;
  const root = roots.find((root) => path.startsWith(`${root}/`));
  // The run's data alias is the account's native storage. Keep ordinary brain
  // artifacts writable there; configuration and the alias directory itself stay protected.
  const suffix = (root ? path.slice(root.length + 1) : '').replace(
    /^\.cat-cafe-native-runs\/run-[a-z0-9]+\/(?=\.gemini\/antigravity-cli\/)/,
    '',
  );
  return (
    suffix === 'library' ||
    suffix === 'library/keychains' ||
    suffix.startsWith('library/keychains/') ||
    suffix === 'library/preferences' ||
    suffix === 'library/preferences/com.apple.security.plist' ||
    suffix === '.gemini/antigravity-cli/antigravity-oauth-token' ||
    suffix === '.gemini' ||
    suffix === '.gemini/antigravity-cli' ||
    suffix === '.gemini/antigravity-acp' ||
    /^\.gemini\/antigravity-acp\/(?:settings\.json|acp_token\.json|acp_business_token\.json|trusted_workspaces\.json)$/.test(
      suffix,
    ) ||
    suffix === '.gemini/config' ||
    suffix.startsWith('.gemini/config/') ||
    /^\.gemini\/antigravity-cli\/(?:settings\.json|skills(?:\/|$)|plugins(?:\/|$)|\.cat-cafe-skills[-.])/.test(
      suffix,
    ) ||
    suffix.startsWith('.cat-cafe-native-turn.sqlite') ||
    suffix === '.cat-cafe-native-runs' ||
    suffix.startsWith('.cat-cafe-native-runs/')
  );
}

function controlPath(path, cwd, profileHome) {
  if (typeof path !== 'string' || !path) return false;
  const absolute = isAbsolute(path) ? path : `${cwd}/${path}`;
  // Preserve ownership of the profile view even when its skill symlink points
  // into an ordinary workspace, where authoring the source is allowed.
  if (profileControlPath(resolve(absolute).toLowerCase(), profileHome)) return true;
  let parent = absolute;
  const suffix = [];
  while (!kernelPath(parent) && dirname(parent) !== parent) {
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  const physical = join(kernelPath(parent) ?? parent, ...suffix)
    .toLowerCase()
    .replaceAll('\\', '/');
  const segments = physical.split('/');
  const agents = segments.lastIndexOf('.agents');
  if (agents >= 0 && (agents === segments.length - 1 || CONTROL_ENTRIES.has(segments[agents + 1]))) return true;
  return profileControlPath(physical, profileHome);
}

/** Never emit an empty allow: AGY treats a successful hook with empty stdout as permission. */
export function decideAgyNativeHookPayload(payload, options = {}) {
  const deny = (reason) => ({ decision: 'deny', reason: `Clowder AI native guard: ${reason}` });
  if (!payload || typeof payload !== 'object' || !payload.toolCall || typeof payload.toolCall !== 'object')
    return deny('invalid AGY tool payload');
  const { name, args } = payload.toolCall;
  if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args))
    return deny('invalid AGY tool arguments');
  const cwd = typeof args.Cwd === 'string' ? args.Cwd : payload.workspacePaths?.[0];
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return deny('missing tool workspace');
  if (options.readOnly && !READERS.has(name)) return deny('read-only invocation');

  let toolName;
  let toolInput;
  if (FILE_WRITERS.has(name)) {
    const target = args.TargetFile ?? args.NotebookPath;
    if (typeof target !== 'string' || !target) return deny('missing file target');
    if (controlPath(target, cwd, options.profileHome)) return deny('AGY executable control-plane write');
    toolName = name === 'write_to_file' ? 'Write' : 'Edit';
    toolInput = { file_path: target };
  } else if (COMMANDS.has(name)) {
    const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const command =
      name === 'run_workflow'
        ? typeof args.Script === 'string'
          ? `python3 -c ${quote(args.Script)}`
          : typeof args.ScriptPath === 'string'
            ? `python3 ${quote(args.ScriptPath)}`
            : undefined
        : (args.CommandLine ?? args.Input);
    if (typeof command !== 'string' || !command) return deny('missing command');
    // The CLI hot-loads these programs outside its terminal sandbox. Their
    // protection is carrier integrity, not another list of protected project files.
    if (commandTouchesAgyControl(command, cwd, options.profileHome, controlPath)) {
      return deny('AGY executable control-plane command');
    }
    toolName = 'Bash';
    toolInput = { command };
  } else {
    // Browser, MCP and model-native interactions retain their canonical
    // provider/callback authority. They do not become shell or file commands.
    return DELEGATED_TOOLS.has(name) ? { decision: 'allow' } : deny(`unknown or unqualified native operation: ${name}`);
  }
  const verdict = decideNativeHookPayload({ tool_name: toolName, tool_input: toolInput, cwd }, options);
  return verdict.decision === 'allow' ? { decision: 'allow' } : deny(verdict.reasonCode);
}

async function main() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) throw new Error('oversized hook input');
    }
    const hostHome = process.argv[2];
    const decision = decideAgyNativeHookPayload(JSON.parse(raw), {
      profileHome: process.env.HOME,
      readOnly: process.argv[3] === 'read-only',
      selfHost: () => readSelfHostFacet({ ...(hostHome ? { homeDir: hostHome } : {}) }),
    });
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ decision: 'deny', reason: 'Clowder AI native guard could not validate this tool call' })}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
