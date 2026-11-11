import { describe, expect, it, vi } from 'vitest';
import { resolveAssetUrl } from '@/components/artifacts/artifact-view';
import { packRead, packText, richRender, terminal } from '../platform';

const renderer = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg><script>alert(1)</script><path d="M0 0L1 1"/></svg>' })),
}));
vi.mock('mermaid', () => ({ default: renderer }));

describe('PDL project richRender platform port', () => {
  it('renders block and inline math using the installed KaTeX, without CSS or font downloads', async () => {
    const block = await richRender('math', 'x^2 + y^2 = z^2');
    const inline = await richRender('math', '\\frac{1}{2}', true);
    expect(block).toContain('<math');
    expect(block).toContain('display="block"');
    expect(inline).toContain('<mfrac>');
    expect(inline).not.toContain('display="block"');
    expect(block).not.toContain('katex-html');
  });

  it('rejects invalid formulas so the copied body component can retain its source fallback', async () => {
    await expect(richRender('math', '\\notARealKatexCommand')).rejects.toThrow();
  });

  it('uses strict Mermaid rendering and sanitizes SVG before returning HTML to the runtime', async () => {
    const html = await richRender('mermaid', 'graph TD; A --> B');
    expect(renderer.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        htmlLabels: false,
        suppressErrorRendering: true,
      }),
    );
    expect(renderer.render).toHaveBeenCalledWith(expect.stringMatching(/^pdl-mermaid-\d+$/), 'graph TD; A --> B');
    expect(html).toContain('<path');
    expect(html).not.toContain('<script');
  });

  it('rejects unsupported content rather than treating it as Mermaid', async () => {
    await expect(richRender('html', '<script>alert(1)</script>')).rejects.toThrow('Unsupported rich content');
  });
});

it.each([
  ['/avatars/codex.png', '/avatars/codex.png'],
  ['/api/cats/codex/avatar', 'https://api.test/api/cats/codex/avatar'],
  ['/uploads/file.png', 'https://api.test/uploads/file.png'],
  ['/pdl/theme/default/logo.svg', '/pdl/theme/default/logo.svg'],
  ['https://external.test/image.png', 'https://external.test/image.png'],
])('routes %s to its actual asset owner', (path, expected) => {
  expect(resolveAssetUrl(path, 'https://api.test')).toBe(expected);
});

const xterm = vi.hoisted(() => ({
  port: {
    options: {} as Record<string, unknown>,
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    dispose: vi.fn(),
  },
  fit: vi.fn(),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: typeof xterm.port, options: Record<string, unknown>) {
    Object.assign(this, xterm.port);
    this.options = options;
    xterm.port.options = options;
  }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = xterm.fit;
  },
}));
it('provides the installed terminal port and its own stylesheet without a CDN or another UI', async () => {
  const el = {} as HTMLElement;
  const port = await terminal(el, { cols: 80 });
  expect(xterm.port.open).toHaveBeenCalledWith(el);
  expect(xterm.port.loadAddon).toHaveBeenCalledOnce();
  port.write('raw\x1b[31m');
  port.reset();
  port.set({ fontSize: 14 });
  port.fit();
  const input = vi.fn(),
    resize = vi.fn();
  port.onData(input);
  port.onResize(resize);
  port.dispose();
  expect(xterm.port.write).toHaveBeenCalledWith('raw\x1b[31m');
  expect(xterm.port.options.fontSize).toBe(14);
  expect(xterm.port.reset).toHaveBeenCalledOnce();
  expect(xterm.fit).toHaveBeenCalledOnce();
  expect(xterm.port.onData).toHaveBeenCalledWith(input);
  expect(xterm.port.onResize).toHaveBeenCalledWith(resize);
  expect(xterm.port.dispose).toHaveBeenCalledOnce();
});

describe('PDL project theme package port', () => {
  it('reads and writes the theme.yaml manifest so the console only handles objects', async () => {
    const pack = {
      id: 'c1',
      name: 'Mine',
      version: '1',
      pdl: { palette: 'cream', doc: { tokens: {} }, base: { v: 4 } },
    };
    const text = packText(pack);
    expect(text).toContain('palette: cream');
    const file = (body: string) => ({ text: async () => body }) as File;
    expect(await packRead(file(text))).toEqual(pack);
    await expect(packRead(file('pdl: [not: closed'))).rejects.toThrow();
  });
});
