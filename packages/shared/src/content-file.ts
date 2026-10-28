import { SOURCE_CODE_EXTENSIONS } from './source-code-extensions.js';

/** File facts shared by catalogue projection, opening and the actual reader. */
export const CONTENT_FILE_MIMES: Readonly<Record<string, string>> = {
  ts: 'text/typescript',
  tsx: 'text/tsx',
  js: 'text/javascript',
  jsx: 'text/jsx',
  json: 'application/json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
  xml: 'application/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};
export type FileContentKind = 'image' | 'video' | 'audio' | 'markdown' | 'html' | 'jsx' | 'text' | 'office' | 'binary';
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'log',
  'json',
  'yml',
  'yaml',
  'toml',
  'xml',
  'csv',
  'tsv',
  'env',
  ...SOURCE_CODE_EXTENSIONS,
]);
export function contentFileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
export function contentFileMime(name: string): string {
  if (!contentFileExtension(name) && /^(license|readme|notice|copying)$/i.test(name.split(/[/\\]/).at(-1) ?? ''))
    return 'text/plain';
  const extension = contentFileExtension(name);
  return (
    CONTENT_FILE_MIMES[extension] ?? (TEXT_FILE_EXTENSIONS.has(extension) ? 'text/plain' : 'application/octet-stream')
  );
}
function specificContentMime(mime?: string): string | undefined {
  const type = mime?.split(';', 1)[0].trim().toLowerCase();
  return type && type !== 'application/octet-stream' ? type : undefined;
}
export function fileContentKind(name: string, mime?: string): FileContentKind {
  const type = specificContentMime(mime);
  const effective = type || contentFileMime(name);
  if (effective.startsWith('image/')) return 'image';
  if (effective.startsWith('video/')) return 'video';
  if (effective.startsWith('audio/')) return 'audio';
  const extension = contentFileExtension(name);
  if (
    type === 'application/pdf' ||
    /^application\/(?:vnd\.(?:openxmlformats-officedocument|ms-|msword)|msword)/.test(type ?? '')
  )
    return 'office';
  if (['md', 'markdown', 'mdx'].includes(extension) || type === 'text/markdown') return 'markdown';
  if (['html', 'htm'].includes(extension) || type === 'text/html') return 'html';
  if (extension === 'jsx' || extension === 'tsx') return 'jsx';
  if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf'].includes(extension)) return 'office';
  if (!extension || TEXT_FILE_EXTENSIONS.has(extension) || type?.startsWith('text/')) return 'text';
  return 'binary';
}

/** Catalogue type records origin; this projection describes the actual content without re-keying that record. */
export function projectFileContent(input: { name: string; url?: string; ref?: string; mime?: string; type?: string }) {
  const media = input.type && ['image', 'video', 'audio'].includes(input.type) ? input.type : null;
  const namedMime = contentFileMime(input.name);
  let urlPath = input.ref ?? '';
  if (input.url) {
    try {
      urlPath = decodeURIComponent(new URL(input.url, 'https://content.invalid').pathname);
    } catch {
      urlPath = '';
    }
  }
  const urlMime = contentFileMime(urlPath);
  const mime =
    specificContentMime(input.mime) ??
    (media
      ? namedMime.startsWith(media + '/')
        ? namedMime
        : urlMime.startsWith(media + '/')
          ? urlMime
          : media + '/octet-stream'
      : namedMime !== 'application/octet-stream'
        ? namedMime
        : urlMime);
  const effectiveName =
    namedMime === 'application/octet-stream' && urlMime !== 'application/octet-stream' ? urlPath : input.name;
  const kind = fileContentKind(effectiveName, mime);
  return { name: input.name, mime, kind, floating: kind === 'image' || kind === 'video' };
}

const READABLE_TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'log',
  'json',
  'css',
  'yaml',
  'yml',
  'toml',
  'xml',
  'csv',
  'tsv',
]);
/** Desktop launch is deliberately narrower than displaying source as text or unpacking an archive. */
export function canLaunchLocalFile(name: string): boolean {
  const extension = contentFileExtension(name);
  if (!extension) return /^(license|readme|notice|copying)$/i.test(name.split(/[/\\]/).at(-1) ?? '');
  const kind = fileContentKind(name);
  if (['image', 'video', 'audio', 'office', 'markdown', 'html'].includes(kind)) return true;
  // Viewing source is not permission to invoke the OS's registered script runner.
  return READABLE_TEXT_FILE_EXTENSIONS.has(extension);
}

/** A URL/route parameter names one upload, including Unicode; it is never an OS locator. */
export function isContentFileBasename(name: string): boolean {
  return (
    name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[/\\\u0000-\u001f\u007f]/u.test(name)
  );
}
