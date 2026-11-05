import { execFileSync } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';

const { transformSync } = createRequire(path.join(process.cwd(), 'package.json'))('esbuild');
const source = execFileSync(
  'git',
  ['show', '949ced0b6:packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts'],
  { encoding: 'utf8' },
);
const compiled = transformSync(source, { loader: 'ts', format: 'esm', target: 'node24' }).code;
registerHooks({
  load(url, context, next) {
    if (url.endsWith('/dist/domains/cats/services/agents/invocation/invoke-single-cat.js'))
      return { format: 'module', source: compiled, shortCircuit: true };
    return next(url, context);
  },
});
