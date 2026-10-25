import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { validateAgyNativeConfigReceipt, writeAgyNativeConfigReceipt } from './agy-native-config-receipt.js';

/** Host-only config: an existing different hook is never overwritten or silently enabled. */
export function materializeAgyNativeEffectGuard(input: {
  profileHome: string;
  accountHome?: string;
  runtimeRoot: string;
  readOnly: boolean;
}): string {
  const script = realpathSync(secretRuntimeScript('agy-native-effect-guard.mjs'));
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  // Carry the host state coordinate separately: isolated OAuth HOME is not the
  // home in which our daemon writes its self-host record.
  const command = [
    process.execPath,
    script,
    homedir(),
    input.readOnly ? 'read-only' : 'normal',
    input.accountHome ?? input.profileHome,
  ]
    .map(quote)
    .join(' ');
  const config = {
    'cat-cafe-native-effect': {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }],
    },
  };
  const path = join(input.profileHome, '.gemini/config/hooks.json');
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error('AGY native guard config is not a regular host file');
    const previous = readFileSync(path, 'utf8');
    // Mode changes only alter the host-generated command. Validate its full
    // shape before replacing; arbitrary profile programs remain inadmissible.
    const other = next.replace(
      quote(input.readOnly ? 'read-only' : 'normal'),
      quote(input.readOnly ? 'normal' : 'read-only'),
    );
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
