import { getLifecycleAppendOutcome, type LifecycleDispatchRef, type LifecycleMessageMetadata } from '@cat-cafe/shared';

export function isUnconfirmedAppend(
  ref: LifecycleDispatchRef | undefined,
  metadata?: LifecycleMessageMetadata,
): boolean {
  return getLifecycleAppendOutcome(ref, metadata) === 'unknown';
}

function formatReceiptTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getMonth() + 1)}/${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

/** Status/time belongs to the exact dispatch; names and content belong to each view. */
export function dispatchReceiptDisplay(
  ref: LifecycleDispatchRef | undefined,
  running: boolean,
  metadata?: LifecycleMessageMetadata,
) {
  if (!ref) return { state: 'unknown', timestamp: undefined, time: undefined, pulse: false };
  const receipt = ref?.inputRead;
  if (receipt?.status === 'read') {
    const timestamp = formatReceiptTimestamp(receipt.at);
    return { state: 'read', timestamp, time: timestamp.slice(6, 11), pulse: false };
  }
  const timestamp =
    typeof ref?.dispatchedAt === 'number' && Number.isFinite(ref.dispatchedAt)
      ? formatReceiptTimestamp(ref.dispatchedAt)
      : undefined;
  const appendOutcome = getLifecycleAppendOutcome(ref, metadata);
  if (appendOutcome === 'not_accepted') return { state: 'not_accepted', timestamp, pulse: false };
  if (appendOutcome === 'incomplete') return { state: 'incomplete', timestamp, pulse: false };
  if (isUnconfirmedAppend(ref, metadata)) {
    const failure = metadata?.appendFailures?.find(
      (candidate) => candidate.targetId === ref.targetId && candidate.responseMessageId === ref.statusMessageId,
    );
    return {
      state: failure?.checkedAt === undefined ? 'checking_delivery' : 'unconfirmed_delivery',
      timestamp,
      pulse: false,
    };
  }
  if (!receipt) return { state: 'unavailable', timestamp, pulse: false };
  return { state: running ? 'pending' : 'unconfirmed', timestamp, pulse: running };
}

/** Reading is independent of reply progress; only the exact dispatch can prove it. */
export function dispatchReadText(receipt: ReturnType<typeof dispatchReceiptDisplay>, includeDelivery = false): string {
  switch (receipt.state) {
    case 'not_accepted':
      return '未接收';
    case 'incomplete':
      return '追加未完成';
    case 'checking_delivery':
      return '正在核对收到没…';
    case 'unconfirmed_delivery':
      return '已送出，没确认收到';
    case 'read':
      return `已读 ${receipt.time}`;
    case 'pending':
      return `${includeDelivery ? '已收到，' : ''}等读取确认`;
    case 'unconfirmed':
      return `${includeDelivery ? '已收到，' : ''}没确认读到`;
    case 'unavailable':
      return `${includeDelivery ? '已收到，' : ''}读没读查不到`;
    default:
      return '状态待核对';
  }
}

export function dispatchReadSummary(receipts: readonly ReturnType<typeof dispatchReceiptDisplay>[]): string {
  if (receipts.length > 0 && receipts.every((receipt) => receipt.state === 'read')) return '全部已读';
  return [
    ['not_accepted', '未接收'],
    ['incomplete', '追加未完成'],
    ['read', '已读'],
    ['pending', '等读取确认'],
    ['unconfirmed', '没确认读到'],
    ['unconfirmed_delivery', '没确认收到'],
    ['checking_delivery', '正在核对收到没'],
    ['unavailable', '读没读查不到'],
    ['unknown', '状态待核对'],
  ]
    .flatMap(([state, label]) => {
      const count = receipts.filter((receipt) => receipt.state === state).length;
      return count ? [`${count} 条${label}`] : [];
    })
    .join(' · ');
}

export function dispatchReceiptLabel(
  receipt: ReturnType<typeof dispatchReceiptDisplay>,
  name: string,
  view: 'recipient' | 'appended_source',
): string {
  if (receipt.state === 'not_accepted') return `${name} · 未并进上一轮（未接收）`;
  if (receipt.state === 'incomplete') return `${name} · 追加未完成`;
  if (view === 'appended_source') return `${name} · ${dispatchReadText(receipt, true)}`;
  if (receipt.state === 'unknown') return `${name} · 状态待核对`;
  if (receipt.state === 'unconfirmed_delivery') return `${name} · 已送出，没确认收到`;
  if (receipt.state === 'checking_delivery') return `正在核对 ${name} 收到没…`;
  const read = receipt.state === 'read';
  const status = read ? `已读 ${name}` : `已投递 ${name}`;
  const unconfirmed = receipt.state === 'unconfirmed' ? '（未确认读取）' : '';
  const time = receipt.timestamp === undefined ? '' : ` · ${receipt.timestamp}`;
  return `${status}${unconfirmed}${time}`;
}
