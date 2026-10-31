import { describe, expect, it } from 'vitest';
import { inferFileKind, inferRenderMode } from '../file-kind';

describe('inferFileKind', () => {
  it('classifies server-supported image extensions as image', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif']) {
      expect(inferFileKind(`assets/x.${ext}`)).toBe('image');
    }
  });

  it('keeps unsupported BMP generic while AVIF shares the server-supported MIME projection', () => {
    expect(inferFileKind('assets/photo.avif')).toBe('image');
    expect(inferFileKind('assets/old.bmp')).toBe('file');
  });

  it('classifies md/mdx as markdown', () => {
    expect(inferFileKind('docs/讲稿.md')).toBe('markdown');
    expect(inferFileKind('docs/x.mdx')).toBe('markdown');
  });

  it('classifies other/unknown extensions as file', () => {
    expect(inferFileKind('src/app.ts')).toBe('file');
    expect(inferFileKind('README')).toBe('file');
  });

  it('is case-insensitive on extension', () => {
    expect(inferFileKind('assets/X.PNG')).toBe('image');
    expect(inferFileKind('docs/X.MD')).toBe('markdown');
  });
});

describe('inferRenderMode', () => {
  it('markdown → rendered, everything else → raw', () => {
    expect(inferRenderMode('docs/x.md')).toBe('rendered');
    expect(inferRenderMode('src/app.ts')).toBe('raw');
    expect(inferRenderMode('assets/x.png')).toBe('raw');
  });
});
