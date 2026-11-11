import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import autoprefixer from 'autoprefixer';
import { build } from 'esbuild-wasm';
import imageConfig from 'next/dist/shared/lib/image-config.js';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import tailwindConfig from '../tailwind.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src/starry');

// Next compiles the standalone document with the same installed JS/CSS tools as the web app.
export default function () {
  const done = this.async();
  build({
    absWorkingDir: root,
    entryPoints: [this.resourcePath],
    outfile: 'starry.js',
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    minify: true,
    metafile: true,
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.__NEXT_IMAGE_OPTS': JSON.stringify({ ...imageConfig.imageConfigDefault, unoptimized: true }),
      'process.env': '{}',
      'import.meta.env': '{"MODE":"production"}',
      'import.meta.url': 'window.location.href',
    },
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    inject: [resolve(source, 'frame-api.ts')],
    plugins: [
      {
        name: 'starry-frame',
        setup(builder) {
          builder.onResolve({ filter: /(?:^|\/)api-client(?:\.[jt]s)?$/ }, () => ({
            path: resolve(source, 'frame-api.ts'),
          }));
          builder.onResolve({ filter: /^@\/hooks\/useVisibleCafePresence$/ }, () => ({
            path: resolve(source, 'frame-presence.ts'),
          }));
        },
      },
    ],
  })
    .then(async (result) => {
      const inputs = Object.keys(result.metafile.inputs).map((path) => resolve(root, path));
      const manifest = resolve(root, 'src/generated/vendor-stylesheets.json');
      for (const path of [...inputs, manifest, resolve(root, 'tailwind.config.js')]) this.addDependency(path);
      const content = inputs
        .filter((path) => path.startsWith(resolve(root, 'src') + '/') && /\.[jt]sx?$/.test(path))
        .map((path) => ({ raw: readFileSync(path, 'utf8'), extension: extname(path).slice(1) }));
      const css = result.outputFiles.find((file) => file.path.endsWith('.css')).text;
      const styles = await postcss([tailwindcss({ ...tailwindConfig, content }), autoprefixer]).process(css, {
        from: undefined,
      });
      const links = JSON.parse(readFileSync(manifest, 'utf8'))
        .map((href) => `<link rel="stylesheet" href="${href}">`)
        .join('');
      const script = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
      const document = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>猫猫星球</title>${links}<style>${styles.css}</style><style>html,body,#starry-root{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="starry-root"></div><script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
      done(null, `export default ${JSON.stringify(document)};`);
    })
    .catch(done);
}
