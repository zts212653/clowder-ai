/**
 * F232 Phase A.1 — ArtifactsPanel 纯函数单元测试。
 * AC-A5: catId → 昵称映射（fallback 原值）+ createdAt → 相对时间（委托 formatRelativeTime）。
 * AC-A7: classifyArtifactView — 产物按 type/数据可用性分发到内容查看策略。
 */
import { describe, expect, it } from 'vitest';
import { artifactRowMeta, classifyArtifactView, prRefToUrl, resolveAssetUrl } from '../artifacts/artifact-view';

describe('F232 AC-A5 artifactRowMeta — catId 昵称映射 + 相对时间', () => {
  const resolveNickname = (id: string): string | undefined =>
    ({ 'opus-48': '宪宪', codex: '砚砚' })[id as 'opus-48' | 'codex'];

  it('known catId → nickname', () => {
    const meta = artifactRowMeta({ catId: 'opus-48', createdAt: Date.now() }, resolveNickname);
    expect(meta.catLabel).toBe('宪宪');
  });

  it('unknown catId → raw catId (fallback, 不崩)', () => {
    const meta = artifactRowMeta({ catId: 'mystery-cat', createdAt: Date.now() }, resolveNickname);
    expect(meta.catLabel).toBe('mystery-cat');
  });

  it('null catId → —', () => {
    const meta = artifactRowMeta({ catId: null, createdAt: Date.now() }, resolveNickname);
    expect(meta.catLabel).toBe('—');
  });

  it('relativeTime 委托 formatRelativeTime (recent → 刚刚)', () => {
    const meta = artifactRowMeta({ catId: null, createdAt: Date.now() }, resolveNickname);
    expect(meta.relativeTime).toBe('刚刚');
  });
});

describe('F232 AC-A7 classifyArtifactView — 产物 → 内容查看策略', () => {
  it('image + url → image', () => {
    expect(classifyArtifactView({ type: 'image', name: 'x.png', url: '/uploads/x.png' })).toBe('image');
  });

  it('audio + url → audio', () => {
    expect(classifyArtifactView({ type: 'audio', name: '语音', url: '/uploads/v.mp3' })).toBe('audio');
  });

  it('pr → pr (打开 GitHub)', () => {
    expect(classifyArtifactView({ type: 'pr', name: 'PR #1', ref: 'org/repo#1' })).toBe('pr');
  });

  it('file 文本扩展名(.md) → text (panel 内看正文)', () => {
    expect(classifyArtifactView({ type: 'file', name: 'BACKLOG.md', ref: 'docs/ROADMAP.md' })).toBe('text');
  });

  it('file 文本扩展名(.log) → text', () => {
    expect(classifyArtifactView({ type: 'file', name: 'debug.log', url: '/uploads/debug.log' })).toBe('text');
  });

  it('code (diff) → text (看源文件正文)', () => {
    expect(classifyArtifactView({ type: 'code', name: 'a.ts', ref: 'src/a.ts' })).toBe('text');
  });

  it('file 二进制扩展名(.pdf) + url → download', () => {
    expect(classifyArtifactView({ type: 'file', name: '报告.pdf', url: '/uploads/r.pdf' })).toBe('download');
  });

  it('file 无扩展名 → text (当文本试)', () => {
    expect(classifyArtifactView({ type: 'file', name: 'LICENSE', ref: 'LICENSE' })).toBe('text');
  });

  // 云端 round 3 P2：未知/二进制扩展名（不在文本 allowlist）必须走 download，
  // 不能 fall through 当文本 fetch+decode（hang panel / 乱码）。改 blocklist → allowlist。
  it('file 未知二进制扩展名(.wasm) → download (不当文本解码)', () => {
    expect(classifyArtifactView({ type: 'file', name: 'model.wasm', url: '/uploads/model.wasm' })).toBe('download');
  });

  it('file 未知二进制扩展名(.bin) → download', () => {
    expect(classifyArtifactView({ type: 'file', name: 'dump.bin', url: '/uploads/dump.bin' })).toBe('download');
  });

  it('file 未在名单的二进制(.heic) → download', () => {
    expect(classifyArtifactView({ type: 'file', name: 'photo.heic', url: '/uploads/photo.heic' })).toBe('download');
  });

  it('无 url 无 ref → fallback (跳回原消息)', () => {
    expect(classifyArtifactView({ type: 'file', name: 'orphan' })).toBe('fallback');
  });

  it('image 无 url → fallback (无内容源)', () => {
    expect(classifyArtifactView({ type: 'image', name: 'x.png' })).toBe('fallback');
  });

  // F232 Phase A.2: video support (AC-A9)
  it('video + url → video (panel 内播放)', () => {
    expect(classifyArtifactView({ type: 'video', name: 'demo.mp4', url: '/uploads/demo.mp4' })).toBe('video');
  });

  it('video 无 url → fallback', () => {
    expect(classifyArtifactView({ type: 'video', name: 'missing.mp4' })).toBe('fallback');
  });
});

describe('F232 AC-A7 prRefToUrl — PR ref → GitHub url', () => {
  it('org/repo#123 → github pull url', () => {
    expect(prRefToUrl('zts212653/cat-cafe#2247')).toBe('https://github.com/zts212653/clowder-ai/pull/2247');
  });

  it('malformed ref → undefined', () => {
    expect(prRefToUrl('not-a-ref')).toBeUndefined();
  });

  it('undefined → undefined', () => {
    expect(prRefToUrl(undefined)).toBeUndefined();
  });
});

describe('F232 resolveAssetUrl — 站内相对路径补前缀', () => {
  it('/uploads/ → 补 apiBase', () => {
    expect(resolveAssetUrl('/uploads/x.png', 'http://h')).toBe('http://h/uploads/x.png');
  });

  it('外链原样返回', () => {
    expect(resolveAssetUrl('https://e.com/x', 'http://h')).toBe('https://e.com/x');
  });

  it('undefined → undefined', () => {
    expect(resolveAssetUrl(undefined, 'http://h')).toBeUndefined();
  });
});
