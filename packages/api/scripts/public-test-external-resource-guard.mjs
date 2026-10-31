import childProcess from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, relative, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const DISTRIBUTABLE_SCOPE = 'distributable';
const LOCAL_HOSTS = new Set(['localhost', '::1']);
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'gh']);
const PRIVILEGE_ESCAPE_COMMANDS = new Set(['sudo', 'nsenter', 'unshare', 'setpriv']);
const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push']);
const PROMISIFY_CUSTOM = promisify.custom;
const LOCAL_COMMAND_FIXTURES_ENV = 'CAT_CAFE_PUBLIC_TEST_LOCAL_COMMAND_FIXTURES';

function violation(detail) {
  const error = new Error(`external_resource_violation: ${detail}`);
  error.code = 'CAT_CAFE_PUBLIC_TEST_EXTERNAL_RESOURCE';
  return error;
}

function normalizedHostname(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
}

export function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value).replace(/\.$/, '');
  return (
    LOCAL_HOSTS.has(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function assertDistributableUrl(value, operation = 'network request') {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(String(value));
  } catch {
    throw violation(`${operation} has an unparseable target`);
  }
  if (['file:', 'data:', 'blob:'].includes(parsed.protocol)) return parsed;
  if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) && isLoopbackHostname(parsed.hostname)) {
    return parsed;
  }
  throw violation(`${operation} cannot access non-loopback target ${parsed.origin}`);
}

function urlsIn(values) {
  return values.flatMap((value) => String(value).match(/(?:https?|wss?|file):\/\/[^\s'"`]+/g) ?? []);
}

function shellCommands(command) {
  return String(command)
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const withoutAssignments = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/, '');
      const match = /^(?:command\s+|env(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=\S+))*\s+)?([^\s]+)/.exec(
        withoutAssignments,
      );
      return match
        ? { command: match[1], executable: basename(match[1]).toLowerCase(), text: withoutAssignments }
        : undefined;
    })
    .filter(Boolean);
}

function assertShellPseudoDeviceTargets(command) {
  const text = String(command);
  for (const marker of text.matchAll(/\/dev\/(?:tcp|udp)(?=$|\/|\s|["'`])/g)) {
    const target = /^\/dev\/(tcp|udp)\/([^\s/'"`;&|<>(){}]+)\/([^\s/'"`;&|<>(){}]+)/.exec(text.slice(marker.index));
    if (!target || !isLoopbackHostname(target[2]) || !/^\d+$/.test(target[3])) {
      throw violation('shell pseudo-device has no provably loopback target');
    }
  }
}

function resolvedExecutable(command, options = {}) {
  const value = String(command);
  const cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
  const environment = options.env ?? process.env;
  const candidates =
    isAbsolute(value) || value.includes('/') || value.includes('\\')
      ? [resolve(cwd, value)]
      : String(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(cwd, directory, value));
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) return undefined;
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function isDeclaredLocalCommandFixture(command, options = {}) {
  const executable = resolvedExecutable(command, options);
  if (!executable) return false;
  const temporaryRoot = realpathSync(tmpdir());
  const declared = String(process.env[LOCAL_COMMAND_FIXTURES_ENV] ?? '')
    .split(delimiter)
    .filter((path) => isAbsolute(path))
    .flatMap((path) => {
      try {
        const candidate = realpathSync(path);
        const fromTemporaryRoot = relative(temporaryRoot, candidate);
        return fromTemporaryRoot && !fromTemporaryRoot.startsWith('..') && !isAbsolute(fromTemporaryRoot)
          ? [candidate]
          : [];
      } catch {
        return [];
      }
    });
  return declared.includes(executable);
}

function shellCommandAllowed(command, options = {}) {
  const text = String(command);
  assertShellPseudoDeviceTargets(text);
  for (const commandPart of shellCommands(text)) {
    if (isDeclaredLocalCommandFixture(commandPart.command, options)) continue;
    if (PRIVILEGE_ESCAPE_COMMANDS.has(commandPart.executable)) {
      throw violation(`distributable tests cannot execute ${commandPart.executable}`);
    }
    if (['gh', 'ssh', 'scp', 'sftp'].includes(commandPart.executable)) {
      throw violation(`distributable tests cannot execute ${commandPart.executable}`);
    }
    if (['curl', 'wget'].includes(commandPart.executable)) {
      const urls = urlsIn([commandPart.text]);
      if (urls.length === 0) throw violation('network command has no provably loopback target');
      for (const url of urls) assertDistributableUrl(url, 'external command');
    }
  }
}

function gitNetworkPolicy(args) {
  const subcommandIndex = args.findIndex((arg) => GIT_NETWORK_SUBCOMMANDS.has(arg));
  if (subcommandIndex < 0) return undefined;
  const target = args.slice(subcommandIndex + 1).find((arg) => !arg.startsWith('-'));
  if (!target) throw violation(`git ${args[subcommandIndex]} has no provably local target`);
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../') || target.startsWith('file:')) {
    return undefined;
  }
  if (!target.includes('://') && !target.includes('@')) return undefined;
  const parsed = assertDistributableUrl(target, `git ${args[subcommandIndex]}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw violation(`git ${args[subcommandIndex]} cannot use ${parsed.protocol}`);
  }
  return { gitAllowProtocol: `file:${parsed.protocol.slice(0, -1)}` };
}

export function assertDistributableCommand(command, args = [], options = {}) {
  const executable = basename(String(command)).toLowerCase();
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  if (isDeclaredLocalCommandFixture(command, options)) return;
  if (PRIVILEGE_ESCAPE_COMMANDS.has(executable)) {
    throw violation(`distributable tests cannot execute ${executable}`);
  }
  if (['sh', 'bash', 'zsh'].includes(executable)) {
    const commandIndex = normalizedArgs.indexOf('-c');
    if (commandIndex >= 0 && normalizedArgs[commandIndex + 1]) {
      shellCommandAllowed(normalizedArgs[commandIndex + 1], options);
    }
    return;
  }
  if (executable === 'env') {
    const nestedIndex = normalizedArgs.findIndex((arg) => !arg.startsWith('-') && !arg.includes('='));
    if (nestedIndex >= 0)
      assertDistributableCommand(normalizedArgs[nestedIndex], normalizedArgs.slice(nestedIndex + 1), options);
    return;
  }
  if (executable === 'git') return gitNetworkPolicy(normalizedArgs);
  if (!NETWORK_COMMANDS.has(executable)) return;
  if (['gh', 'ssh', 'scp', 'sftp'].includes(executable)) {
    throw violation(`distributable tests cannot execute ${executable}`);
  }
  const urls = urlsIn(normalizedArgs);
  if (urls.length === 0) throw violation(`${executable} has no provably loopback target`);
  for (const url of urls) assertDistributableUrl(url, executable);
}

function guardedCommandOptions(options = {}, policy) {
  const env = { ...(options.env ?? process.env) };
  for (const key of ['CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE', 'NODE_OPTIONS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_ALLOW_PROTOCOL = policy?.gitAllowProtocol ?? process.env.GIT_ALLOW_PROTOCOL ?? 'file';
  return { ...options, env };
}

function guardedFileCommandArguments(args, rest, policy) {
  if (Array.isArray(args)) {
    const [first, ...tail] = rest;
    const hasOptions = first && typeof first === 'object' && !Array.isArray(first);
    const options = guardedCommandOptions(hasOptions ? first : {}, policy);
    return hasOptions ? [args, options, ...tail] : [args, options, ...rest];
  }
  if (args && typeof args === 'object') return [guardedCommandOptions(args, policy), ...rest];
  if (typeof args === 'function') return [guardedCommandOptions({}, policy), args, ...rest];
  return [guardedCommandOptions({}, policy), ...rest];
}

function fileCommandOptions(args, rest) {
  if (Array.isArray(args)) {
    const [first] = rest;
    return first && typeof first === 'object' && !Array.isArray(first) ? first : {};
  }
  return args && typeof args === 'object' ? args : {};
}

function guardedShellCommandArguments(args) {
  const [first, ...tail] = args;
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return [guardedCommandOptions(first), ...tail];
  }
  return [guardedCommandOptions({}), ...args];
}

function requestTarget(args, protocol) {
  const [first] = args;
  if (typeof first === 'string' || first instanceof URL) return first;
  if (!first || typeof first !== 'object') return undefined;
  if (first.socketPath) return 'unix-socket';
  const host = first.hostname ?? first.host;
  if (!host) return undefined;
  const port = first.port ? `:${first.port}` : '';
  return `${protocol}//${host}${port}${first.path ?? '/'}`;
}

function connectHost(args) {
  const [first, second] = args;
  if (first && typeof first === 'object') return first.host ?? first.hostname ?? 'localhost';
  if (typeof first === 'number') return typeof second === 'string' ? second : 'localhost';
  return undefined;
}

function preserveFunctionProperties(wrapper, original) {
  for (const key of Reflect.ownKeys(original)) {
    if (['length', 'name', 'prototype'].includes(key) || key === PROMISIFY_CUSTOM) continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor) Object.defineProperty(wrapper, key, descriptor);
  }
  return wrapper;
}

function preserveGuardedPromisify(wrapper, original, guard) {
  const descriptor = Object.getOwnPropertyDescriptor(original, PROMISIFY_CUSTOM);
  if (!descriptor || typeof descriptor.value !== 'function') return wrapper;
  Object.defineProperty(wrapper, PROMISIFY_CUSTOM, {
    ...descriptor,
    value: function guardedPromisifiedCommand(...args) {
      return guard(descriptor.value, this, args);
    },
  });
  return wrapper;
}

function installGuard() {
  if (process.env.CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE !== DISTRIBUTABLE_SCOPE) return;

  process.env.GIT_ALLOW_PROTOCOL = 'file';
  const guardImport = `--import=${fileURLToPath(import.meta.url)}`;
  if (!(process.env.NODE_OPTIONS ?? '').split(/\s+/).includes(guardImport)) {
    process.env.NODE_OPTIONS = `${guardImport}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ''}`;
  }

  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, ...args) {
      const target = typeof Request !== 'undefined' && input instanceof Request ? input.url : input;
      assertDistributableUrl(target, 'fetch');
      return originalFetch.call(this, input, ...args);
    };
  }
  if (typeof globalThis.WebSocket === 'function') {
    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class GuardedWebSocket extends OriginalWebSocket {
      constructor(url, ...args) {
        assertDistributableUrl(url, 'WebSocket');
        super(url, ...args);
      }
    };
  }

  for (const [module, protocol] of [
    [http, 'http:'],
    [https, 'https:'],
  ]) {
    for (const method of ['request', 'get']) {
      const original = module[method];
      module[method] = function guardedRequest(...args) {
        const target = requestTarget(args, protocol);
        if (target === 'unix-socket') return original.apply(this, args);
        if (target) assertDistributableUrl(target, `${protocol}${method}`);
        else throw violation(`${protocol}${method} has no provably loopback target`);
        return original.apply(this, args);
      };
    }
  }

  for (const [module, methods] of [
    [net, ['connect', 'createConnection']],
    [tls, ['connect']],
  ]) {
    for (const method of methods) {
      const original = module[method];
      module[method] = function guardedConnect(...args) {
        const host = connectHost(args);
        if (host !== undefined && !isLoopbackHostname(host)) {
          throw violation(`${method} cannot access non-loopback host ${host}`);
        }
        return original.apply(this, args);
      };
    }
  }

  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[method];
    const wrapper = preserveFunctionProperties(function guardedFileCommand(command, args, ...rest) {
      const policy = assertDistributableCommand(
        command,
        Array.isArray(args) ? args : [],
        fileCommandOptions(args, rest),
      );
      return original.call(this, command, ...guardedFileCommandArguments(args, rest, policy));
    }, original);
    childProcess[method] = preserveGuardedPromisify(wrapper, original, (originalPromisified, receiver, args) => {
      const [command, commandArgs, ...rest] = args;
      const policy = assertDistributableCommand(
        command,
        Array.isArray(commandArgs) ? commandArgs : [],
        fileCommandOptions(commandArgs, rest),
      );
      return originalPromisified.call(receiver, command, ...guardedFileCommandArguments(commandArgs, rest, policy));
    });
  }
  for (const method of ['exec', 'execSync']) {
    const original = childProcess[method];
    const wrapper = preserveFunctionProperties(function guardedShellCommand(command, ...args) {
      shellCommandAllowed(command, args[0]);
      return original.call(this, command, ...guardedShellCommandArguments(args));
    }, original);
    childProcess[method] = preserveGuardedPromisify(wrapper, original, (originalPromisified, receiver, args) => {
      const [command, ...rest] = args;
      shellCommandAllowed(command, rest[0]);
      return originalPromisified.call(receiver, command, ...guardedShellCommandArguments(rest));
    });
  }
  syncBuiltinESMExports();
}

installGuard();
