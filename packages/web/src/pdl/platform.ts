import type { ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm';
import DOMPurify from 'dompurify';
import { parse, stringify } from 'yaml';

let diagramId = 0;

export async function terminal(el: HTMLElement, options: ITerminalOptions & ITerminalInitOnlyOptions) {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  const term = new Terminal(options),
    fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  return {
    write: (data: string) => term.write(data),
    reset: () => term.reset(),
    set: (value: ITerminalOptions) => Object.assign(term.options, value),
    fit: () => fit.fit(),
    onData: (fn: (data: string) => void) => term.onData(fn),
    onResize: (fn: (size: { cols: number; rows: number }) => void) => term.onResize(fn),
    dispose: () => term.dispose(),
  };
}

/** Implements the copied runtime's platform port with the application's installed libraries. */
export async function richRender(kind: string, source: string, inline = false): Promise<string> {
  if (kind === 'math') {
    const katex = await import('katex');
    return katex.renderToString(source, {
      displayMode: !inline,
      throwOnError: true,
      output: 'mathml',
      trust: false,
    });
  }
  if (kind !== 'mermaid') throw new Error(`Unsupported rich content: ${kind}`);
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.dataset.mode === 'dark' ? 'dark' : 'neutral',
    htmlLabels: false,
    suppressErrorRendering: true,
  });
  const { svg } = await mermaid.render(`pdl-mermaid-${++diagramId}`, source);
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

/** An authenticated export response becomes a source for the runtime's existing download action. */
export async function downloadPayload(response: Response, name: string) {
  const source = URL.createObjectURL(await response.blob());
  return { source, name, release: () => URL.revokeObjectURL(source) };
}

/** Theme packages: the manifest (theme.yaml) is YAML only in the host; the console reads and writes objects. */
export async function packRead(file: File): Promise<unknown> {
  return parse(await file.text());
}
export function packText(pack: unknown): string {
  return stringify(pack);
}
