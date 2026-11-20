import { ghHelpEnabled, ghOperation, ghParameters } from './secret-gh-options.mjs';
import { withSendValue } from './secret-send-options.mjs';

const AUTOFILL = new Set(['--fill', '-f', '--fill-first', '--fill-verbose']);
const DERIVED = new Set(['--editor', '-e', '--web', '-w', '--recover', '--template', '-T']);

export async function prepareGhArgs(args, freeze) {
  const operation = ghOperation(args);
  if (operation.unresolved || !operation.group) return args;
  const parameters = ghParameters(args, operation);
  if (ghHelpEnabled(parameters)) return args;
  const output = [];
  let rewritten = false;
  const inspect = (path) => {
    rewritten = true;
    return freeze(path);
  };
  let positional = 0;
  for (const argument of parameters) {
    if (argument.kind === 'operand' && argument.index > operation.actionIndex) {
      const file = fileOperand(operation, positional++);
      if (!file) output.push(argument.word);
      else output.push(await inspectOperand(operation, argument.word, inspect));
    } else {
      output.push(...(await ghArgument(argument, operation, inspect)));
    }
  }
  if (operation.group === 'gist' && operation.action === 'create' && positional === 0) output.push(await inspect('-'));
  const names = new Set(parameters.filter(({ kind }) => kind === 'flag' || kind === 'value').map(({ name }) => name));
  requireExplicitBody(operation, names, positional);
  return rewritten ? output : args;
}

async function ghArgument(argument, operation, freeze) {
  if (argument.kind === 'flag' || argument.kind === 'value') rejectDerived(argument.name, operation);
  if (argument.kind === 'value') {
    // pflag accepts -F=file; curl instead treats '=' as part of a short value.
    const value = /^-[^-]=/.test(argument.word) ? argument.value.slice(1) : argument.value;
    return withSendValue(argument, await ghValue(argument.name, value, operation, freeze));
  }
  return [argument.word];
}

function rejectDerived(name, operation) {
  if (!['pr', 'issue'].includes(operation.group) || !['create', 'comment', 'review', 'edit'].includes(operation.action))
    return;
  if (operation.group === 'pr' && operation.action === 'create' && AUTOFILL.has(name))
    throw new Error('secret_send_generated_pr_body');
  if (DERIVED.has(name)) throw new Error('secret_send_implicit_content_unsupported');
}

function fileOperand(operation, positional) {
  if (operation.group === 'ssh-key') return operation.action === 'add' && positional === 0;
  if (operation.group === 'gist')
    return operation.action === 'create' || (operation.action === 'edit' && positional > 0);
  return operation.group === 'release' && ['create', 'upload'].includes(operation.action) && positional > 0;
}

async function inspectOperand({ group }, value, freeze) {
  if (group !== 'release') return freeze(value);
  const label = value.indexOf('#');
  if (label < 0) return freeze(value);
  return `${await freeze(value.slice(0, label))}${value.slice(label)}`;
}

async function ghValue(name, value, operation, freeze) {
  if (usesBodyFile(operation) && ['--body-file', '-F'].includes(name)) return freeze(value);
  if (
    (operation.group === 'release' &&
      ['create', 'edit'].includes(operation.action) &&
      ['--notes-file', '-F'].includes(name)) ||
    (operation.group === 'gist' && operation.action === 'edit' && ['--add', '-a'].includes(name)) ||
    (operation.group === 'api' && name === '--input')
  )
    return freeze(value);
  if (operation.group === 'api' && ['--field', '-F'].includes(name)) {
    const marker = value.indexOf('=@');
    if (marker >= 0) return `${value.slice(0, marker + 2)}${await freeze(value.slice(marker + 2))}`;
  }
  return value;
}

function usesBodyFile({ group, action }) {
  if (group === 'pr' && ['review', 'merge'].includes(action)) return true;
  return ['pr', 'issue'].includes(group) && ['create', 'edit', 'comment'].includes(action);
}

function requireExplicitBody(operation, names, positional) {
  if (operation.group === 'gist' && operation.action === 'edit') {
    if (positional < 2 && !['--add', '-a', '--desc', '-d', '--remove', '-r'].some((name) => names.has(name)))
      throw new Error('secret_send_implicit_content_unsupported');
    return;
  }
  if (!['pr', 'issue'].includes(operation.group)) return;
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
