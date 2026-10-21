import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const directory = new URL('../fixtures/kimi-native/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const dependencies = {
  zod: pathToFileURL(require.resolve('kimi-native-parser-zod')).href,
  pathe: pathToFileURL(require.resolve('pathe')).href,
};
// No application bootstrap is imported: HOME must be supplied by each fixture.
const shim = moduleUrl(`
export function resolveKimiHome(home) { if (!home) throw Error('Explicit fixture HOME required'); return home; }
export class KimiError extends Error { constructor(code, message, options) { super(message, options); this.code = code; } }
export class Error2 extends KimiError {}
export class HostFsError extends KimiError {}
export const ErrorCodes = { CONFIG_INVALID: 'CONFIG_INVALID' };
export const OsFsErrors = { codes: { OS_FS_NOT_FOUND: 'ENOENT' } };
`);

async function nativeModule(name, imports) {
  const entry = manifest.find((item) => item.name === name);
  const source = (await readFile(new URL(name, directory), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(source).digest('hex'), entry.sha256, `Native fixture drift: ${name}`);
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mapped = javascript.replace(/from (['"])([^'"]+)\1/g, (statement, quote, specifier) => {
    const target = { ...dependencies, ...imports }[specifier];
    if (!target && specifier.startsWith('#/')) throw Error(`Unmapped native import: ${specifier}`);
    return target ? `from ${quote}${target}${quote}` : statement;
  });
  return moduleUrl(mapped);
}

const schema034 = await nativeModule('0.34-schema.ts.txt', {});
const schema22 = await nativeModule('2.2-schema.ts.txt', {});
const git = await nativeModule('0.34-v2-git.ts.txt', {});
const v1 = await nativeModule('0.34-loader.ts.txt', {
  '#/config/path': shim,
  '#/config/schema': schema034,
  '#/errors': shim,
});
const v2 = await nativeModule('0.34-v2-loader.ts.txt', {
  '#/app/git/workTree': git,
  '#/app/bootstrap/bootstrap': shim,
  '#/os/interface/hostFsErrors': shim,
  '#/mcpCore/config-schema': schema034,
  '#/errors': shim,
});
const { HostFsError } = await import(shim);
const fs = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      throw new HostFsError(error.code, error.message);
    }
  },
  async stat(path) {
    const value = await stat(path);
    return { isDirectory: value.isDirectory(), isFile: value.isFile() };
  },
};

export const nativeSchemas = {
  '0.34.0': (await import(schema034)).McpServerConfigSchema,
  '2.2.0': (await import(schema22)).McpServerConfigSchema,
};
export const nativeLoaders = {
  '0.34-v1': (input) => import(v1).then((native) => native.loadMcpServers(input)),
  '0.34-v2': (input) => import(v2).then((native) => native.loadMcpServers({ ...input, fs })),
};
