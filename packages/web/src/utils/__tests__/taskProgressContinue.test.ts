import { describe, expect, it } from 'vitest';
import { buildContinueMessage } from '@/utils/taskProgressContinue';

describe('buildContinueMessage', () => {
  it('includes @mention and renders remaining tasks first', () => {
    const msg = buildContinueMessage('opus', {
      tasks: [
        { id: '1', subject: 'Read files', status: 'completed' },
        { id: '2', subject: 'Fix bug', status: 'in_progress' },
        { id: '3', subject: 'Run tests', status: 'pending' },
      ],
      lastUpdate: 1,
      snapshotStatus: 'interrupted',
    });
    expect(msg).toContain('@opus 🔁');
    const idxRemaining = msg.indexOf('未完成:');
    const idxAll = msg.indexOf('全部任务:');
    expect(idxRemaining).toBeGreaterThanOrEqual(0);
    expect(idxAll).toBeGreaterThan(idxRemaining);
    expect(msg).toContain('- [ ] Fix bug');
    expect(msg).toContain('- [ ] Run tests');
  });

  it('does not duplicate an existing @ mention prefix', () => {
    const msg = buildContinueMessage('@opus', {
      tasks: [],
      lastUpdate: 1,
      snapshotStatus: 'interrupted',
    });

    expect(msg).toContain('@opus 🔁');
    expect(msg).not.toContain('@@opus');
  });
});
