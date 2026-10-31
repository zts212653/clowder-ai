const VALUES = new Set([
  '--filter',
  '-F',
  '--dir',
  '-C',
  '--prefix',
  '--workspace-concurrency',
  '--reporter',
  '--config',
  '--loglevel',
]);
const FLAGS = new Set([
  '-w',
  '--workspace-root',
  '-r',
  '--recursive',
  '-s',
  '--silent',
  '--stream',
  '--parallel',
  '--aggregate-output',
  '--if-present',
  '--color',
  '--no-color',
  '--offline',
  '--no-bail',
  '--sequential',
  '--no-reporter-hide-prefix',
  '--report-summary',
]);
const SHELL_FLAGS = new Set(['-c', '--shell-mode']);
const NPM_VALUES = new Set([
  '--package',
  '--workspace',
  '-w',
  '--prefix',
  '--cache',
  '--registry',
  '--userconfig',
  '--globalconfig',
  '--loglevel',
]);
const NPM_FLAGS = new Set([
  '-y',
  '--yes',
  '--no',
  '--offline',
  '--prefer-offline',
  '--ignore-scripts',
  '--workspaces',
  '--include-workspace-root',
  '-s',
  '--silent',
  '--if-present',
  '--no-audit',
  '--no-fund',
  '--no-progress',
]);

/** npm exec/x owns child argv or --call; npm run/run-script owns a script name. */
export function packageManagerInvocation(name, operands = []) {
  if (name === 'pnpm') return pnpmInvocation(operands);
  if (name !== 'npm') return { kind: 'other', complete: true };
  const prefix = npmOptions(operands, 0);
  const unknown = { kind: 'unknown', complete: false, candidates: operands };
  if (!prefix.complete) return unknown;
  const selector = operands[prefix.index];
  if (!['exec', 'x', 'run', 'run-script'].includes(selector)) return { kind: 'other', complete: true };
  const selection = npmOptions(operands, prefix.index + 1);
  if (!selection.complete) return unknown;
  const argv = operands.slice(selection.index);
  if (['run', 'run-script'].includes(selector))
    return withCoordinate({ kind: 'script', complete: true, script: argv[0] }, prefix, selection);
  const source = selection.source ?? prefix.source;
  if (source !== undefined)
    return withCoordinate({ kind: 'shell', complete: argv.length === 0, source }, prefix, selection);
  return argv.length ? withCoordinate({ kind: 'argv', complete: true, argv }, prefix, selection) : unknown;
}

function withCoordinate(result, prefix, selection) {
  const cwd = selection.cwd ?? prefix.cwd;
  const cwdUnknown = prefix.cwdUnknown || selection.cwdUnknown;
  return {
    ...result,
    ...(cwd === undefined ? {} : { cwd }),
    ...(cwdUnknown ? { cwdUnknown: true, complete: false } : {}),
  };
}

function npmOptions(tokens, start) {
  let index = start,
    source,
    cwd,
    cwdUnknown = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return { index: index + 1, source, cwd, cwdUnknown, complete: true };
    if (!token.startsWith('-')) break;
    const name = token.split('=', 1)[0];
    if (NPM_VALUES.has(name) || ['-c', '--call'].includes(name)) {
      const value = token.includes('=') ? token.slice(name.length + 1) : tokens[++index];
      if (value === undefined) return { index, complete: false };
      if (['-c', '--call'].includes(name)) source = value;
      if (name === '--prefix') cwd = value;
      if (['-w', '--workspace'].includes(name)) cwdUnknown = true;
    } else if (!NPM_FLAGS.has(name) || (token.includes('=') && !/=(?:true|false)$/.test(token))) {
      return { index, complete: false };
    }
    if (['--workspaces', '--include-workspace-root'].includes(name) && !token.endsWith('=false')) cwdUnknown = true;
    index += 1;
  }
  return { index, source, cwd, cwdUnknown, complete: true };
}

/** pnpm owns options and script selection; exec owns child argv or a shell string. */
export function pnpmInvocation(operands = []) {
  const prefix = optionsBeforeCommand(operands, 0);
  if (!prefix.complete) return { kind: 'unknown', complete: false, candidates: operands.slice(prefix.index) };
  const selector = operands[prefix.index];
  // dlx resolves a package's bin, not a package script or attested argv program.
  if (selector === 'dlx') return { kind: 'unknown', complete: false, candidates: operands.slice(prefix.index + 1) };
  if (!['run', 'run-script', 'exec'].includes(selector)) return { kind: 'script', complete: true, script: selector };
  const selection = optionsBeforeCommand(operands, prefix.index + 1);
  if (!selection.complete) return { kind: 'unknown', complete: false, candidates: operands.slice(selection.index) };
  if (selector === 'run' || selector === 'run-script')
    return withCoordinate({ kind: 'script', complete: true, script: operands[selection.index] }, prefix, selection);
  const argv = operands.slice(selection.index);
  if (!argv.length) return { kind: 'unknown', complete: false, candidates: [] };
  return withCoordinate(
    prefix.shell || selection.shell
      ? { kind: 'shell', complete: true, source: argv.join(' ') }
      : { kind: 'argv', complete: true, argv },
    prefix,
    selection,
  );
}

function optionsBeforeCommand(tokens, start) {
  let index = start,
    shell = false,
    cwd;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') return { index: index + 1, shell, cwd, complete: true };
    if (!token.startsWith('-')) return { index, shell, cwd, complete: true };
    const name = token.split('=', 1)[0];
    if (VALUES.has(name)) {
      if (!token.includes('=')) {
        if (tokens[index + 1] === undefined) return { index, shell, complete: false };
        index += 1;
      }
      if (['--dir', '-C', '--prefix'].includes(name))
        cwd = token.includes('=') ? token.slice(name.length + 1) : tokens[index];
    } else if (SHELL_FLAGS.has(token)) shell = true;
    else if (!FLAGS.has(token)) return { index, shell, complete: false };
    index += 1;
  }
  return { index, shell, cwd, complete: true };
}
