/** Identify the DSH executable, never a provider mentioned in arbitrary arguments. */
export function isDshLauncher(command: string, startupArgs: readonly string[] = []) {
  const executable = command.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return (
    /^dsh(?:\.(?:cmd|exe|bat))?$/i.test(executable) ||
    (/^node(?:\.exe)?$/i.test(executable) &&
      /(?:^|\/)node_modules\/@deepseek-ai\/dsh\/(?:lib\/bin\.js|src\/bin\.ts)$/.test(
        (startupArgs[0] ?? '').replaceAll('\\', '/'),
      ))
  );
}
