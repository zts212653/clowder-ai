'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '@/utils/api-client';

// Dynamic import to avoid polluting test environment (esbuild-wasm checks TextEncoder at import time)
type EsbuildModule = typeof import('esbuild-wasm');
let esbuildReady: Promise<EsbuildModule> | null = null;

function ensureEsbuild(): Promise<EsbuildModule> {
  if (!esbuildReady) {
    esbuildReady = import('esbuild-wasm')
      .then(async (mod) => {
        await mod
          .initialize({
            wasmURL: '/vendor/esbuild/esbuild.wasm',
          })
          .catch((err) => {
            if (!String(err).includes('already')) throw err;
          });
        return mod;
      })
      .catch((err) => {
        esbuildReady = null;
        throw err;
      });
  }
  return esbuildReady;
}

/** Known React-ecosystem packages → esm.sh CDN URLs */
const ESM_SH_MAP: Record<string, string> = {
  react: 'https://esm.sh/react@18?dev',
  'react/jsx-runtime': 'https://esm.sh/react@18/jsx-runtime?dev',
  'react/jsx-dev-runtime': 'https://esm.sh/react@18/jsx-dev-runtime?dev',
  'react-dom': 'https://esm.sh/react-dom@18?dev',
  'react-dom/client': 'https://esm.sh/react-dom@18/client?dev',
};

/** Fetch file content from workspace API */
async function fetchWorkspaceFile(worktreeId: string, filePath: string): Promise<string | null> {
  const url = `${API_URL}/api/workspace/file?worktreeId=${encodeURIComponent(worktreeId)}&path=${encodeURIComponent(filePath)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.content ?? null;
  } catch {
    return null;
  }
}

/** Resolve relative path against a directory */
function resolveRelative(from: string, rel: string): string {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '.';
  const parts = `${dir}/${rel}`.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p !== '.') resolved.push(p);
  }
  return resolved.join('/');
}

/** Try resolving a path with common extensions */
const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

async function resolveWithExtensions(
  worktreeId: string,
  basePath: string,
): Promise<{ path: string; content: string } | null> {
  for (const ext of EXTENSIONS) {
    const tryPath = basePath + ext;
    const content = await fetchWorkspaceFile(worktreeId, tryPath);
    if (content !== null) return { path: tryPath, content };
  }
  return null;
}

interface JsxPreviewProps {
  code: string;
  filePath: string;
  worktreeId?: string | null;
}

export function JsxPreview({ code, filePath, worktreeId }: JsxPreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);

  const build = useCallback(async () => {
    setBuilding(true);
    setError(null);
    try {
      const mod = await ensureEsbuild();
      const isTs = filePath.endsWith('.tsx') || filePath.endsWith('.ts');

      // esbuild plugin: resolve local imports via workspace API, npm packages via esm.sh
      const workspacePlugin: import('esbuild-wasm').Plugin = {
        name: 'workspace-resolver',
        setup(pluginBuild) {
          // Mark npm packages as external (post-process rewrite to esm.sh)
          pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
            if (ESM_SH_MAP[args.path]) {
              return { path: ESM_SH_MAP[args.path], external: true };
            }
            // Unknown npm package → esm.sh fallback
            return { path: `https://esm.sh/${args.path}?dev`, external: true };
          });

          // Resolve relative imports via workspace API
          // stdin entry has importer="<stdin>" which is truthy but not a real path
          pluginBuild.onResolve({ filter: /^\./ }, (args) => {
            const base = !args.importer || args.importer === '<stdin>' ? filePath : args.importer;
            const resolved = resolveRelative(base, args.path);
            return { path: resolved, namespace: 'workspace' };
          });

          // Load workspace files
          pluginBuild.onLoad({ filter: /.*/, namespace: 'workspace' }, async (args) => {
            if (!worktreeId) return { contents: '', loader: 'js' as const };
            const result = await resolveWithExtensions(worktreeId, args.path);
            if (!result) return { contents: `// Could not resolve: ${args.path}`, loader: 'js' as const };
            const ext = result.path.split('.').pop() ?? '';
            const loader = (['tsx', 'ts'].includes(ext) ? 'tsx' : 'jsx') as 'tsx' | 'jsx';
            return {
              contents: result.content,
              loader,
              resolveDir: result.path.includes('/') ? result.path.slice(0, result.path.lastIndexOf('/')) : '.',
            };
          });
        },
      };

      const result = await mod.build({
        stdin: {
          contents: code,
          loader: isTs ? 'tsx' : 'jsx',
          resolveDir: '.',
        },
        bundle: true,
        write: false,
        format: 'esm',
        jsx: 'automatic',
        target: 'es2020',
        plugins: [workspacePlugin],
      });

      const js = result.outputFiles?.[0]?.text ?? '';

      const previewHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import { createElement } from 'https://esm.sh/react@18?dev';
    import { createRoot } from 'https://esm.sh/react-dom@18/client?dev';
    try {
      const code = ${JSON.stringify(js)};
      const blob = new Blob([code], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      URL.revokeObjectURL(url);

      const Component = mod.default ?? mod.App ?? null;
      if (Component) {
        const root = createRoot(document.getElementById('root'));
        root.render(createElement(Component));
      } else {
        document.getElementById('root').innerHTML =
          '<p style="color:#888;font-size:13px">No default export or App component found to render.</p>';
      }
    } catch (err) {
      document.getElementById('root').innerHTML =
        '<pre style="color:#e53;font-size:12px;white-space:pre-wrap">' +
        err.message + '\\n' + (err.stack || '') + '</pre>';
    }
  </script>
</body>
</html>`;

      setHtml(previewHtml);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }, [code, filePath, worktreeId]);

  useEffect(() => {
    build();
  }, [build]);

  if (building) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#1E1E24] text-cafe-muted text-xs">
        Bundling JSX/TSX...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 overflow-auto bg-[#1E1E24] p-4">
        <div className="text-red-400 text-xs font-mono whitespace-pre-wrap">
          <div className="font-semibold mb-2">Bundle Error</div>
          {error}
        </div>
      </div>
    );
  }

  if (!html) return null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-2 py-1 bg-blue-900/20 text-blue-400 text-[10px] border-b border-blue-900/30 flex-shrink-0">
        JSX Preview (esbuild-wasm) — local imports resolved, npm packages via esm.sh
      </div>
      <div className="flex-1 min-h-0 bg-cafe-surface">
        <iframe srcDoc={html} sandbox="allow-scripts" title="JSX Preview" className="w-full h-full border-0" />
      </div>
    </div>
  );
}
