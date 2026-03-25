declare module 'qrcode' {
  export function toDataURL(text: string, options?: { width?: number; margin?: number }): Promise<string>;
}
