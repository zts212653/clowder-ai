import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

import { uploadAvatarAsset } from '@/components/hub-cat-editor.client';

describe('uploadAvatarAsset size gate', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    // Default to a successful response so that without a size gate the function would resolve.
    // The Red→Green transition is driven by whether the size gate prevents the fetch call.
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ url: '/uploads/x.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('rejects raw file larger than the avatar limit before sending request', async () => {
    const oversized = new File([new ArrayBuffer(11 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    });
    await expect(uploadAvatarAsset(oversized)).rejects.toThrow(/过大|too large/i);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('forwards request to /api/uploads/avatar with multipart FormData', async () => {
    const small = new File([new Uint8Array(1024)], 'small.png', { type: 'image/png' });
    const url = await uploadAvatarAsset(small);
    expect(url).toBe('/uploads/x.png');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockApiFetch.mock.calls[0]!;
    expect(requestUrl).toBe('/api/uploads/avatar');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.body).toBeInstanceOf(FormData);
    const body = requestInit?.body as FormData;
    const filePart = body.get('file');
    expect(filePart).toBeInstanceOf(File);
  });
});
