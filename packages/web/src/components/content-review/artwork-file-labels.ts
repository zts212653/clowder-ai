import type { ShellLanguage } from '@/components/shell/shell-language';

/** One display projection for byte lengths from the file's source metadata. */
export function fileByteLengthLabel(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Dates follow the reader's shell language, not the host process/browser default. */
export function artworkFileDate(value: string | undefined, language: ShellLanguage, now = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Only Apple's identified Preview bundle has this translated product name; arbitrary app names stay intact. */
export function artworkApplicationName(name: string | null | undefined, bundleId: string | undefined, preview: string) {
  return bundleId === 'com.apple.Preview' ? preview : name;
}
