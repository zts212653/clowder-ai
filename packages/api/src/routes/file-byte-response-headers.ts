import { basename } from 'node:path';
import { projectFileContent } from '@cat-cafe/shared';

/** Byte responses may display media, but never run uploaded markup in the API's authority. */
export function fileByteResponseHeaders(path: string, mime: string, attachment: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': attachment ? 'application/octet-stream' : mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': attachment
      ? "default-src 'none'; sandbox"
      : "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'; sandbox",
  };
  if (attachment) {
    const name = encodeURIComponent(basename(path)).replace(
      /[!'()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    headers['Content-Disposition'] = `attachment; filename="download"; filename*=UTF-8''${name}`;
  }
  return headers;
}

/** Static uploads and connector attachments keep public byte reads, with the same inert representation policy. */
export function setStoredFileHeaders(
  response: { setHeader(name: string, value: string): unknown },
  path: string,
): void {
  const { kind, mime } = projectFileContent({ name: basename(path) });
  for (const [name, value] of Object.entries(
    fileByteResponseHeaders(path, mime, !['image', 'video', 'audio'].includes(kind)),
  ))
    response.setHeader(name, value);
}
