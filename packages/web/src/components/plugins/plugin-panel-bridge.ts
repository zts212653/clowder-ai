export const pluginPanelChannel = 'clowder-plugin-ui/v1';
const csp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
export function sandboxedPanelHtml(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !('kind' in value) ||
    value.kind !== 'plugin-panel' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('html' in value) ||
    typeof value.html !== 'string' ||
    value.html.length > 2_000_000
  )
    throw new Error('插件面板内容无效');
  return `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${value.html}`;
}
export async function copyPanelImage(value: unknown): Promise<void> {
  if (typeof value !== 'string' || value.length > 10_700_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('图片格式无效');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length > 8_000_000 || !signature.every((v, i) => bytes[i] === v)) throw new Error('仅支持复制 PNG 图片');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
}
