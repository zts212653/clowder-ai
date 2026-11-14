import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

/** Bundle the real Host component and its production Tailwind/theme inputs. */
export async function buildPluginPanelBrowser() {
  const webRoot = resolve('../web');
  const require = createRequire(import.meta.url);
  const webRequire = createRequire(join(webRoot, 'package.json'));
  const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
  const components = ['plugins/PluginUiEntries.tsx', 'ConfirmDialog.tsx', 'settings/plugin-manager/PluginVisual.tsx'];
  const bundle = await esbuild.build({
    absWorkingDir: webRoot,
    stdin: {
      resolveDir: webRoot,
      loader: 'tsx',
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{PluginUiEntries}from'./src/components/plugins/PluginUiEntries';createRoot(document.getElementById('rail')).render(<PluginUiEntries/>);`,
    },
    jsx: 'automatic',
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env': JSON.stringify({ NODE_ENV: 'test' }) },
    alias: { '@': join(webRoot, 'src') },
  });
  const globals = join(webRoot, 'src/app/globals.css');
  const themeFiles = ['theme-tokens.css', 'theme-extras.css', 'console-tokens.css'];
  const themes = await Promise.all(themeFiles.map((name) => readFile(join(webRoot, 'src/app', name), 'utf8')));
  const generated = await webRequire('postcss')([
    webRequire('tailwindcss')({
      ...webRequire(join(webRoot, 'tailwind.config.js')),
      content: components.map((name) => join(webRoot, 'src/components', name)),
    }),
  ]).process(await readFile(globals, 'utf8'), { from: globals });
  const css = [...themes, generated.css].join('\n');
  return {
    script: bundle.outputFiles[0].text as string,
    css,
    cssSha256: createHash('sha256').update(css).digest('hex'),
    cssSources: ['globals.css', ...themeFiles],
  };
}
