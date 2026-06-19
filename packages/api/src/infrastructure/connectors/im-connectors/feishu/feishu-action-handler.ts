/**
 * Feishu action handler — AC-A17/A18
 *
 * Handles QR-based authorization flow via the generic action state machine.
 * Extracted from the main plugin to keep index.ts within file size limits.
 */

import { DefaultFeishuQrBindClient, type FeishuQrBindClient } from '../../FeishuQrBindClient.js';
import type { HandleActionContext, HandleActionResult } from '../../im-connector-plugin.js';

export async function handleFeishuAction(actionId: string, ctx: HandleActionContext): Promise<HandleActionResult> {
  const { log } = ctx;
  const qrClient: FeishuQrBindClient =
    (ctx._testOverrides?.feishuQrBindClient as FeishuQrBindClient) ?? new DefaultFeishuQrBindClient();

  switch (actionId) {
    case 'qr-generate': {
      const result = await qrClient.create();
      return {
        render: 'img',
        data: { url: result.qrUrl, qrPayload: result.qrPayload },
      };
    }

    case 'qr-status': {
      const qrPayload = (ctx.operationState?.lastResult?.data as { qrPayload?: string })?.qrPayload;
      if (!qrPayload) {
        return { render: 'status', data: { status: 'error', message: 'No QR payload' }, advance: false };
      }
      const status = await qrClient.poll(qrPayload);
      if (status.status === 'confirmed' && status.appId && status.appSecret) {
        log.info('[Feishu handleAction] QR confirmed — credentials acquired');
        // Auto-switch to websocket when no verification token (same as legacy route).
        // QR-based login is typically for internal/dev setups without public webhook URL.
        const currentMode = ctx.env.FEISHU_CONNECTION_MODE === 'websocket' ? 'websocket' : 'webhook';
        const verificationToken = ctx.env.FEISHU_VERIFICATION_TOKEN;
        const effectiveMode =
          currentMode === 'webhook' && (!verificationToken || verificationToken.trim() === '')
            ? 'websocket'
            : currentMode;
        const targets: Record<string, string> = {
          FEISHU_APP_ID: status.appId,
          FEISHU_APP_SECRET: status.appSecret,
          FEISHU_CONNECTION_MODE: effectiveMode,
        };
        return {
          render: 'status',
          data: { status: 'confirmed' },
          label: '已授权',
          targetValues: targets,
        };
      }
      // Carry qrPayload through polling iterations — without it, the next poll
      // reads persisted lastResult and finds qrPayload wiped (was the QR flash bug).
      return { render: 'polling', data: { status: status.status, qrPayload }, advance: false };
    }

    case 'disconnect': {
      log.info('[Feishu handleAction] Disconnected by user');
      return {
        render: 'status',
        data: { status: 'disconnected' },
        label: '已断开',
        targetValues: { FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' },
        activate: false,
      };
    }

    default:
      throw new Error(`Unknown feishu action: ${actionId}`);
  }
}
