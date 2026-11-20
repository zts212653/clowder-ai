import type { AcpContentBlock, AcpPromptCapabilities } from './types.js';

export type AcpPromptInput = string | readonly AcpContentBlock[];
export type AcpImageInputErrorCode =
  | 'image_input_unsupported'
  | 'image_input_unavailable'
  | 'image_input_invalid'
  | 'image_input_too_large';

export class AcpImageInputError extends Error {
  constructor(
    public readonly code: AcpImageInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AcpImageInputError';
  }
}

export function requireAcpImageCapability(capabilities?: AcpPromptCapabilities): void {
  if (capabilities?.image !== true)
    throw new AcpImageInputError('image_input_unsupported', '该 ACP agent 未声明图片输入能力，图片未发送。');
}

/** Snapshot caller-owned blocks before admission or asynchronous transport writes. */
export function toAcpPromptContent(input: AcpPromptInput, capabilities?: AcpPromptCapabilities): AcpContentBlock[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (input.some((block) => block.type === 'image')) requireAcpImageCapability(capabilities);
  return input.map((block) => ({ ...block }));
}
