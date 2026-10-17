export interface NativeLoginState {
  status: 'login_required' | 'configured' | 'unknown' | 'not_installed';
  checkedAt: number;
  loginCommand?: string;
  loginShell?: 'powershell' | 'sh';
}

interface NativeIdentity {
  configurationSource?: string;
  clientId: string;
  accountRef?: string;
  commandArgs?: string | readonly string[];
  cliConfigArgs?: readonly string[];
  acp?: unknown;
}
/** A default CLI probe only describes its own default connection. */
export function usesDefaultNativeIdentity(config: NativeIdentity): boolean {
  const customCommand =
    typeof config.commandArgs === 'string' ? config.commandArgs.trim().length > 0 : Boolean(config.commandArgs?.length);
  return (
    config.configurationSource === 'native_tool' &&
    ['openai', 'anthropic', 'kimi'].includes(config.clientId) &&
    !config.accountRef?.trim() &&
    !config.acp &&
    !customCommand &&
    !config.cliConfigArgs?.length
  );
}
