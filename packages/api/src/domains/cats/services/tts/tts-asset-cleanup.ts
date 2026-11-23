import { type Stats, statSync, unlinkSync } from 'node:fs';

/** Unknown filesystem errors never authorize removal of durable links. */
export function inspectAudioFileSync(file: string): Stats | 'missing' | 'unknown' {
  try {
    const current = statSync(file);
    return current.isFile() ? current : 'missing';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

/** Call within the repository's synchronous removal transaction. */
export function deleteAudioFileSync(file: string): { deleted: boolean; freedBytes: number } | undefined {
  const before = inspectAudioFileSync(file);
  let deleted = false;
  try {
    unlinkSync(file);
    deleted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (inspectAudioFileSync(file) !== 'missing') return undefined;
  }
  let receiptBytes = 0;
  try {
    const receipt = statSync(`${file}.voice.json`);
    unlinkSync(`${file}.voice.json`);
    receiptBytes = receipt.size;
  } catch {
    // A missing or inaccessible optional receipt does not resurrect deleted audio.
  }
  return { deleted, freedBytes: (deleted && typeof before !== 'string' ? before.size : 0) + receiptBytes };
}
