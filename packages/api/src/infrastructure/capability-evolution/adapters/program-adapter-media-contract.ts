export const PROGRAM_ADAPTER_MEDIA_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;

export type ProgramAdapterMediaContentType = (typeof PROGRAM_ADAPTER_MEDIA_CONTENT_TYPES)[number];

export const PROGRAM_ADAPTER_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
