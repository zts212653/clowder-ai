import { describe, expect, it, vi } from 'vitest';
import { ReadAloudPcm } from '../ReadAloudPcm';

function pcmChunk(sample: number) {
  const sampleRate = 24_000;
  const frames = 11_520;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'));
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, frames * 2, true);
  view.setInt16(44, sample, true);
  return btoa(String.fromCharCode(...bytes));
}

function fixture() {
  const nodes: Array<{
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const completeBuffer = { duration: 1.4 };
  const audio = {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    decodeAudioData: vi.fn().mockResolvedValue(completeBuffer),
    createBuffer: (_channels: number, frames: number, rate: number) => {
      const samples = new Float32Array(frames);
      return { duration: frames / rate, getChannelData: () => samples };
    },
    createBufferSource: () => {
      const node = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      nodes.push(node);
      return node;
    },
  };
  const output = { playing: vi.fn(), complete: vi.fn(), error: vi.fn() };
  const player = new ReadAloudPcm(audio as unknown as AudioContext, output);
  return { audio, player, nodes, output };
}

describe('chat read-aloud PCM timing', () => {
  it('starts at the first timely chunk and schedules the next frame without an audio-source restart', async () => {
    const { audio, player, nodes, output } = fixture();
    const sent = performance.now();
    player.pushChunk({ chunkIndex: 0, audioBase64: pcmChunk(16384), isFinalChunk: false }, sent + 350);
    expect(nodes).toHaveLength(1);
    expect(output.playing).toHaveBeenCalledWith(true);
    audio.currentTime = 0.31;
    player.pushChunk({ chunkIndex: 1, audioBase64: pcmChunk(-8192), isFinalChunk: true }, sent + 620);
    expect(nodes[1].start.mock.calls[0][0]).toBeCloseTo(nodes[0].start.mock.calls[0][0] + 0.48, 7);
    expect(nodes.map((node) => node.buffer?.getChannelData(0)[0])).toEqual([0.5, -0.25]);
    const fetchAsset = vi.fn();
    await player.finishSentence(2, fetchAsset);
    expect(fetchAsset).not.toHaveBeenCalled();
    player.finish();
    nodes[0].onended?.();
    expect(output.complete).not.toHaveBeenCalled();
    nodes[1].onended?.();
    expect(output.complete).toHaveBeenCalledOnce();
  });

  it('waits for the complete asset when synthesis falls behind the first two packets', async () => {
    const { player, audio, nodes } = fixture();
    const sent = performance.now();
    player.pushChunk({ chunkIndex: 0, audioBase64: pcmChunk(16384), isFinalChunk: false }, sent + 780);
    player.pushChunk({ chunkIndex: 1, audioBase64: pcmChunk(16384), isFinalChunk: false }, sent + 1490);
    player.pushChunk({ chunkIndex: 2, audioBase64: pcmChunk(16384), isFinalChunk: true }, sent + 2150);
    expect(nodes).toHaveLength(0);
    const fetchAsset = vi.fn().mockResolvedValue(new ArrayBuffer(44));
    await player.finishSentence(3, fetchAsset);
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(audio.decodeAudioData).toHaveBeenCalledOnce();
    expect(nodes).toHaveLength(1);
  });

  it('reads the full asset for a late shared subscriber and fences an old download on stop', async () => {
    const { player, audio, nodes } = fixture();
    player.pushChunk({ chunkIndex: 1, audioBase64: pcmChunk(16384), isFinalChunk: true });
    expect(nodes).toHaveLength(0);
    const download = Promise.withResolvers<ArrayBuffer>();
    const finished = player.finishSentence(undefined, () => download.promise);
    player.close();
    download.resolve(new ArrayBuffer(44));
    await finished;
    expect(audio.close).toHaveBeenCalledOnce();
    expect(audio.decodeAudioData).not.toHaveBeenCalled();
    expect(nodes).toHaveLength(0);
  });
});
