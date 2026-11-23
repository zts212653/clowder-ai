import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { validateAgyNativeConfigReceipt, writeAgyNativeConfigReceipt } from './agy-native-config-receipt.js';

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildEffectGuardCommand(args: readonly string[]): string {
  if (process.platform === 'win32') {
    // AGY executes hook commands via cmd.exe on Windows. Wrap the invocation in
    // PowerShell `-EncodedCommand` (base64 UTF-16LE, strictly [A-Za-z0-9+/=]) so
    // cmd.exe (/c, /s /c, and /v:on delayed expansion) never interprets spaces,
    // Unicode characters, &, %VAR%, !VAR!, or quotes, while stdin/stdout/exit code pass through.
    const [executable, ...rest] = args;
    const script = `& ${psLiteral(executable)} ${rest.map(psLiteral).join(' ')}; exit $LASTEXITCODE`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return args.map(quote).join(' ');
}

/** Host-only config: an existing different hook is never overwritten or silently enabled. */
export function materializeAgyNativeEffectGuard(input: {
  profileHome: string;
  accountHome?: string;
  credentialHome?: string;
  runtimeRoot: string;
  readOnly: boolean;
  /** Host-admitted command directory; legacy hook callers can omit it. */
  workspaceRoot?: string;
  pluginServerName?: string;
  requireApproval?: boolean;
  allowWorkspaceWrites?: boolean;
  approvalBridgeFile?: string;
}): string {
  const script = realpathSync(secretRuntimeScript('agy-native-effect-guard.mjs'));
  const resolvedWorkspace = input.workspaceRoot !== undefined ? realpathSync(input.workspaceRoot) : undefined;
  const preToolTimeout = input.approvalBridgeFile !== undefined ? 1800 : 5;
  // Carry the host state coordinate separately: isolated OAuth HOME is not the
  // home in which our daemon writes its self-host record.
  const buildConfig = (readOnly: boolean): string => {
    const command = buildEffectGuardCommand([
      process.execPath,
      script,
      homedir(),
      input.pluginServerName !== undefined ? 'plugin-native' : readOnly ? 'read-only' : 'normal',
      input.accountHome ?? input.profileHome,
      ...(resolvedWorkspace !== undefined ? [resolvedWorkspace] : []),
      ...(input.pluginServerName !== undefined ? [input.pluginServerName] : []),
      ...(input.credentialHome !== undefined ? [`--credential-home=${input.credentialHome}`] : []),
      ...(input.requireApproval ? ['--require-approval'] : []),
      ...(input.allowWorkspaceWrites ? ['--allow-workspace-writes'] : []),
      ...(input.approvalBridgeFile !== undefined ? [`--approval-bridge-file=${input.approvalBridgeFile}`] : []),
    ]);
    const config = {
      'cat-cafe-native-effect': {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: preToolTimeout }] }],
        PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command, timeout: 5 }] }],
      },
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  };
  const path = join(input.profileHome, '.gemini/config/hooks.json');
  const next = buildConfig(input.readOnly);
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('AGY native guard config is not a regular host file');
    const previous = readFileSync(path, 'utf8');
    // Mode changes only alter the host-generated command. Validate its full
    // shape before replacing; arbitrary profile programs remain inadmissible.
    const other = buildConfig(!input.readOnly);
    if (
      previous !== next &&
      previous !== other &&
      !validateAgyNativeConfigReceipt(input.profileHome, previous, input.runtimeRoot, undefined, 'guard')
    )
      throw new Error('AGY native guard config was altered after materialization');
  }
  writeFileSync(path, next, { encoding: 'utf8', mode: 0o600 });
  writeAgyNativeConfigReceipt(input.profileHome, next, input.runtimeRoot, undefined, 'guard');
  return path;
}
