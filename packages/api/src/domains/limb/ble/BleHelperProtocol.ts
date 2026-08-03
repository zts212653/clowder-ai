import { Buffer } from 'node:buffer';
import { z } from 'zod';

export const BLE_HELPER_PROTOCOL = 'ble-helper' as const;
export const BLE_HELPER_PROTOCOL_VERSION = 1 as const;
export const BLE_HELPER_MAX_LINE_BYTES = 64 * 1024;
export const BLE_HELPER_COMMANDS = [
  'scan.start',
  'scan.stop',
  'device.inspect',
  'gatt.read',
  'device.disconnect',
  'helper.shutdown',
] as const;

export type BleHelperCommand = (typeof BLE_HELPER_COMMANDS)[number];

const boundedId = z.string().min(1).max(128);
const boundedUuid = z.string().min(1).max(64);
const base = {
  protocol: z.literal(BLE_HELPER_PROTOCOL),
  version: z.literal(BLE_HELPER_PROTOCOL_VERSION),
};

const helloSchema = z
  .object({
    ...base,
    kind: z.literal('hello'),
  })
  .strict();

const responseSchema = z
  .object({
    ...base,
    kind: z.literal('response'),
    requestId: boundedId,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.ok && !value.error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Failed response requires an error' });
    }
  });

const scanDiscoveredEventSchema = z
  .object({
    ...base,
    kind: z.literal('event'),
    event: z.literal('scan.discovered'),
    data: z
      .object({
        sessionId: boundedId,
        deviceId: boundedId,
        name: z.string().max(128).nullable(),
        rssi: z.number().int().min(-127).max(20),
        serviceUuids: z.array(boundedUuid).max(64),
      })
      .strict(),
  })
  .strict();

const scanStateEventSchema = z
  .object({
    ...base,
    kind: z.literal('event'),
    event: z.literal('scan.state'),
    data: z
      .object({
        sessionId: boundedId,
        state: z.enum(['started', 'stopped', 'timeout']),
      })
      .strict(),
  })
  .strict();

const adapterStateEventSchema = z
  .object({
    ...base,
    kind: z.literal('event'),
    event: z.literal('adapter.state'),
    data: z
      .object({
        state: z.enum(['poweredOn', 'poweredOff', 'unauthorized', 'unsupported', 'resetting', 'unknown']),
      })
      .strict(),
  })
  .strict();

const disconnectedEventSchema = z
  .object({
    ...base,
    kind: z.literal('event'),
    event: z.literal('device.disconnected'),
    data: z
      .object({
        deviceId: boundedId,
        reason: z.string().max(256).nullable(),
      })
      .strict(),
  })
  .strict();

const inboundSchema = z.union([
  helloSchema,
  responseSchema,
  scanDiscoveredEventSchema,
  scanStateEventSchema,
  adapterStateEventSchema,
  disconnectedEventSchema,
]);

export type BleHelperHello = z.infer<typeof helloSchema>;
export type BleHelperResponse = z.infer<typeof responseSchema>;
export type BleHelperEvent =
  | z.infer<typeof scanDiscoveredEventSchema>
  | z.infer<typeof scanStateEventSchema>
  | z.infer<typeof adapterStateEventSchema>
  | z.infer<typeof disconnectedEventSchema>;
export type BleHelperInboundMessage = BleHelperHello | BleHelperResponse | BleHelperEvent;

const requestParamsSchemas: Record<BleHelperCommand, z.ZodType<Record<string, unknown>>> = {
  'scan.start': z.object({ sessionId: boundedId, timeoutMs: z.number().int().min(1).max(30_000) }).strict(),
  'scan.stop': z.object({ sessionId: boundedId }).strict(),
  'device.inspect': z.object({ deviceId: boundedId }).strict(),
  'gatt.read': z.object({ deviceId: boundedId, serviceUuid: boundedUuid, characteristicUuid: boundedUuid }).strict(),
  'device.disconnect': z.object({ deviceId: boundedId }).strict(),
  'helper.shutdown': z.object({}).strict(),
};

export function encodeBleHelperRequest(command: string, params: Record<string, unknown>, requestId: string): string {
  if (!BLE_HELPER_COMMANDS.includes(command as BleHelperCommand)) {
    throw new Error(`Unsupported BLE helper command: ${command}`);
  }
  const parsedParams = requestParamsSchemas[command as BleHelperCommand].safeParse(params);
  if (!parsedParams.success) {
    throw new Error(`Invalid BLE helper params for ${command}: ${parsedParams.error.message}`);
  }
  const parsedRequestId = boundedId.safeParse(requestId);
  if (!parsedRequestId.success) throw new Error('Invalid BLE helper requestId');
  const line = JSON.stringify({
    protocol: BLE_HELPER_PROTOCOL,
    version: BLE_HELPER_PROTOCOL_VERSION,
    requestId,
    command,
    params: parsedParams.data,
  });
  if (Buffer.byteLength(line, 'utf8') > BLE_HELPER_MAX_LINE_BYTES) {
    throw new Error('BLE helper request exceeds line size limit');
  }
  return `${line}\n`;
}

export function parseBleHelperMessage(line: string): BleHelperInboundMessage {
  if (Buffer.byteLength(line, 'utf8') > BLE_HELPER_MAX_LINE_BYTES) {
    throw new Error(`BLE helper message exceeds ${BLE_HELPER_MAX_LINE_BYTES} bytes`);
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Invalid BLE helper JSON');
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version !== BLE_HELPER_PROTOCOL_VERSION
  ) {
    throw new Error(`Unsupported BLE helper protocol version: ${String(value.version)}`);
  }
  if (typeof value === 'object' && value !== null && 'protocol' in value && value.protocol !== BLE_HELPER_PROTOCOL) {
    throw new Error(`Unsupported BLE helper protocol: ${String(value.protocol)}`);
  }

  const parsed = inboundSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid BLE helper message: ${parsed.error.message}`);
  return parsed.data as BleHelperInboundMessage;
}
