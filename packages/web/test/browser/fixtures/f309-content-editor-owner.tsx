import { createRoot } from 'react-dom/client';
import { ContentEditorOwnerSurface } from '../../../src/components/workbench/content-editor/ContentEditorOwnerSurface';

const sessionRef = `editor-session:${'a'.repeat(64)}`;
const sessionToken = `editor_${'b'.repeat(40)}`;
const surfaceIntegrity = `sha256-${'A'.repeat(43)}=`;
const requests: Array<{ url: string; method: string }> = [];

const fetchImpl: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  requests.push({ url, method });
  if (method === 'DELETE') return new Response(null, { status: 204 });
  if (url.endsWith('/api/collaborative-content/editor-bridge')) {
    return new Response(
      JSON.stringify({
        ok: true,
        value: {
          contentIdentity: 'opaque-doc-1',
          fileName: 'proposal.docx',
          ownerRevision: 1,
          blobDigest: `sha256:${'c'.repeat(64)}`,
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytesBase64: 'UEsDBA==',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      sessionRef,
      sessionToken,
      surface: {
        v: 1,
        kind: 'f202-content-editor-surface-admission',
        providerId: 'genoffice-docx',
        installationInstanceId: 'plugin-instance-1',
        providerVersion: '0.8.1039',
        packageDigest: 'sha512-package-1',
        grantRevision: 1,
        lifecycleRevision: 1,
        activationState: 'enabled',
        runtimeState: 'healthy',
        rendererOrigin: 'https://renderer.f309.test',
        entrypointPath: '/packages/package-1/assets/renderer/index.html',
        surfaceIntegrity,
        bridgeVersion: '1.0.0',
        sandbox: 'dedicated-origin-iframe',
        framingPolicy: {
          kind: 'csp-frame-ancestors',
          parentOrigin: window.location.origin,
        },
        navigationPolicy: 'navigation-api-deny',
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

Object.assign(window, { __f309Requests: requests });

const root = document.querySelector('#root');
if (!(root instanceof HTMLElement)) throw new Error('F309 browser fixture root is missing');
createRoot(root).render(
  <ContentEditorOwnerSurface
    target={{ contentRef: 'project:alpha/assets/proposal.docx', sessionRef }}
    apiBase="https://api.f309.test"
    fetchImpl={fetchImpl}
  />,
);
