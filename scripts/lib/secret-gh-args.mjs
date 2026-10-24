import { ghOperation, ghOptionPolicy } from './secret-gh-options.mjs';
import { sendArguments } from './secret-send-options.mjs';

const DERIVED = new Set([
  '--editor',
  '-e',
  '--web',
  '-w',
  '--fill',
  '-f',
  '--fill-first',
  '--fill-verbose',
  '--recover',
  '--template',
  '-T',
]);

export async function prepareGhArgs(args, freeze) {
  const operation = ghOperation(args);
  if (operation.action === 'new' && ['gist', 'release', 'pr', 'issue'].includes(operation.group))
    operation.action = 'create';
  rejectCredentialDisclosure(operation, args);
  const options = ghOptionPolicy(operation);
  if (options.passthrough) return args;
  const parameters = sendArguments(args, options.values, options.flags);
  const output = [];
  let positional = 0;
  for (const argument of parameters) {
    if (argument.kind === 'operand' && argument.index > operation.actionIndex) {
      const file = fileOperand(operation, positional++);
      output.push(file ? await freezeAsset(argument.word, freeze) : argument.word);
    } else {
      output.push(...(await ghArgument(argument, operation, options.flags, freeze)));
    }
  }
  if (operation.group === 'gist' && operation.action === 'create' && positional === 0) output.push(await freeze('-'));
  const names = new Set(parameters.filter(({ kind }) => kind === 'flag' || kind === 'value').map(({ name }) => name));
  requireExplicitBody(operation, names, positional);
  return output;
}

async function ghArgument(argument, operation, flags, freeze) {
  if (argument.kind === 'value') {
    rejectDerived(argument.name, operation);
    // pflag accepts -F=file; curl instead treats '=' as part of a short value.
    const value = /^-[^-]=/.test(argument.word) ? argument.value.slice(1) : argument.value;
    return [argument.name, await ghValue(argument.name, value, operation, freeze)];
  }
  if (argument.kind === 'flag') {
    if (operation.group === 'auth' && ['--show-token', '-t'].includes(argument.name))
      throw new Error('credential_disclosure_blocked_before_read');
    rejectDerived(argument.name, operation);
    if (flags && !flags.has(argument.name)) throw new Error('secret_send_option_unsupported');
  }
  return [argument.word];
}

function rejectDerived(name, operation) {
  if (
    ['pr', 'issue'].includes(operation.group) &&
    DERIVED.has(name) &&
    ['create', 'comment', 'review', 'edit'].includes(operation.action)
  )
    throw new Error('secret_send_implicit_content_unsupported');
}

function rejectCredentialDisclosure(operation, args) {
  if (operation.group === 'auth' && (operation.action === 'token' || args.includes('--show-token')))
    throw new Error('credential_disclosure_blocked_before_read');
}

function fileOperand(operation, positional) {
  if (operation.group === 'gist')
    return operation.action === 'create' || (operation.action === 'edit' && positional > 0);
  return operation.group === 'release' && ['create', 'upload'].includes(operation.action) && positional > 0;
}

async function freezeAsset(value, freeze) {
  const label = value.indexOf('#');
  if (label < 0) return freeze(value);
  return `${await freeze(value.slice(0, label))}${value.slice(label)}`;
}

async function ghValue(name, value, operation, freeze) {
  if (
    ['--body-file', '--notes-file', '--input'].includes(name) ||
    (name === '-F' && operation.group !== 'api') ||
    (operation.group === 'gist' && ['--add', '-a'].includes(name))
  )
    return freeze(value);
  if (operation.group === 'api' && ['--field', '-F'].includes(name)) {
    const marker = value.indexOf('=@');
    if (marker >= 0) return `${value.slice(0, marker + 2)}${await freeze(value.slice(marker + 2))}`;
  }
  return value;
}

function requireExplicitBody(operation, names, positional) {
  if (operation.group === 'gist' && operation.action === 'edit') {
    if (positional < 2 && !['--add', '-a', '--desc', '-d', '--remove', '-r', '--help'].some((name) => names.has(name)))
      throw new Error('secret_send_implicit_content_unsupported');
    return;
  }
  if (!['pr', 'issue'].includes(operation.group)) return;
  if (names.has('--help') || names.has('-h')) return;
  if (operation.action === 'edit' && [...names].every((name) => ['--repo', '-R', '--hostname'].includes(name)))
    throw new Error('secret_send_implicit_content_unsupported');
  if (
    operation.action === 'review' &&
    !['--approve', '-a'].some((name) => names.has(name)) &&
    !['--body', '-b', '--body-file', '-F'].some((name) => names.has(name))
  )
    throw new Error('secret_send_implicit_content_unsupported');
  if (!['create', 'new', 'comment'].includes(operation.action)) return;
  if (!['--body', '-b', '--body-file', '-F'].some((name) => names.has(name)))
    throw new Error('secret_send_implicit_content_unsupported');
}
