import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function runtimePackageFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'package-runtime-bundle-'));
  const root = path.join(base, 'deploy');
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  write('dependencies/.runtime-lock.json', JSON.stringify({ lockHash: 'a'.repeat(64) }));
  const peer = (folder, token) => {
    write(`${folder}/package.json`, '{"name":"peer","type":"module","exports":"./index.js"}');
    write(`${folder}/index.js`, `export const token=${JSON.stringify(token)};`);
  };
  peer('dependencies/peer', 'public');
  const shared = 'dependencies/@cat-cafe/shared';
  const manifest = {
    name: '@cat-cafe/shared',
    version: '1',
    type: 'module',
    exports: {
      '.': { import: './dist/index.js' },
      './registry': { import: './dist/registry/index.js' },
      './location': { import: './dist/location.js' },
    },
  };
  write(`${shared}/package.json`, JSON.stringify(manifest));
  peer(`${shared}/node_modules/peer`, 'private');
  write(
    `${shared}/dist/registry/CatRegistry.js`,
    `import {token} from 'peer'; export class CatRegistry { value=token; } export const catRegistry=new CatRegistry();`,
  );
  write(`${shared}/dist/registry/index.js`, "export * from './CatRegistry.js';");
  write(
    `${shared}/dist/location.js`,
    `import fs from 'node:fs'; export const originalUrl=import.meta.url; export const asset=JSON.parse(fs.readFileSync(new URL('./asset.json',import.meta.url))).value;`,
  );
  write(`${shared}/dist/asset.json`, '{"value":7}');
  let code = "export * from './registry/index.js'; export * from './location.js';\n";
  for (let index = 0; index < 12; index++) {
    write(`${shared}/dist/leaf-${index}.js`, `export const leaf${index}={value:${index}};`);
    code += `export * from './leaf-${index}.js';\n`;
  }
  write(`${shared}/dist/index.js`, code);
  const contract = (folder = 'dependencies/@clowder-ai/plugin-contract', version = '21') => {
    write(
      `${folder}/package.json`,
      JSON.stringify({
        name: '@clowder-ai/plugin-contract',
        type: 'module',
        version,
        exports: {
          '.': { import: './dist/index.js' },
          './validation': { import: './dist/validation/index.js' },
          './schemas/test': './src/schemas/test.json',
        },
      }),
    );
    write(`${folder}/dist/index.js`, "export * from './validation/index.js';");
    write(
      `${folder}/dist/validation/index.js`,
      `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export const schema=require('@clowder-ai/plugin-contract/schemas/test'); export class ContractError extends Error{} export const token={version:${JSON.stringify(version)}};`,
    );
    write(`${folder}/src/schemas/test.json`, '{"value":42}');
    return folder;
  };
  contract();
  return { base, root, write, shared, contract, peer, manifest };
}

export function runRuntimeWitness(root, code) {
  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(root, 'dependencies'), modules, 'junction');
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    }),
  );
}
