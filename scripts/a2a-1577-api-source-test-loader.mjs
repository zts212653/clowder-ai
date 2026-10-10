// Transitional source-only verification while the aggregate merge is unresolved.
// Do not use this loader as evidence of a fresh API build or compiled consumers.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const api = new URL('../packages/api/', import.meta.url);
const tests = new URL('test/', api).href;
const dist = new URL('dist/', api).href;
const src = new URL('src/', api).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(tests) && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
      const url = new URL(specifier, context.parentURL).href;
      if (url.startsWith(dist) && url.endsWith('.js')) {
        const source = `${src}${url.slice(dist.length, -3)}.ts`;
        if (existsSync(fileURLToPath(source))) return nextResolve(source, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
