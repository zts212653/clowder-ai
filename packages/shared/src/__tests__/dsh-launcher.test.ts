import { expect, it } from 'vitest';
import { isDshLauncher } from '../dsh-launcher.js';

it.each([
  ['dsh', ['--profile', 'acp'], true],
  ['C:\\tools\\dsh.cmd', [], true],
  ['/usr/local/bin/dsh', [], true],
  ['node.exe', ['C:\\cache\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', '--profile', 'acp'], true],
  ['custom-acp', ['--provider', 'deepseek'], false],
  ['custom-acp', ['--config', 'dsh.json'], false],
  ['/opt/dsh/custom-acp', [], false],
  ['node', ['custom.js', '--provider', 'deepseek'], false],
  ['node', ['custom.js', '/cache/node_modules/@deepseek-ai/dsh/lib/bin.js'], false],
  ['dsh-wrapper', [], false],
] as const)('recognizes only the DSH launch entry: %s %j', (command, args, expected) => {
  expect(isDshLauncher(command, args)).toBe(expected);
});
