import type { RedisClient } from '@cat-cafe/shared/utils';
import { AuthInvocationKeys } from './auth-invocation-keys.js';
import { WATCHER_TOOL_ROUTES, type WatcherTicketClaim, type WatcherToolTicket } from './WatcherToolTicket.js';

const UPDATE = `
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then return {'denied'} end
local policy = redis.call('HGET', KEYS[1], 'toolExecutionPolicy')
if not policy or cjson.decode(policy).mode ~= 'watcher' then return {'denied'} end
local calls = cjson.decode(redis.call('HGET', KEYS[1], 'watcherToolCalls') or '[]')
local ticket = nil
for _, value in ipairs(calls) do
  if type(value) == 'table' and value.id == ARGV[2] then ticket = value end
  if type(value) == 'string' and value == ARGV[2] then return {'denied'} end
end
if ARGV[1] == 'admit' then
  if ticket then return {'replayed'} end
  if #calls >= 6 then return {'exhausted'} end
  calls[#calls+1] = {id=ARGV[2], toolName=ARGV[3], route=ARGV[4]}
elseif ARGV[1] == 'claim' then
  if not ticket or ticket.route ~= ARGV[3] then return {'denied'} end
  if ticket.requestHash and ticket.requestHash ~= ARGV[4] then return {'denied'} end
  if ticket.response then return {'completed', cjson.encode(ticket.response)} end
  if ticket.requestHash then return {'in_progress'} end
  ticket.requestHash = ARGV[4]
elseif ARGV[1] == 'complete' then
  if not ticket or not ticket.requestHash then return {'denied'} end
  if ticket.response then return {'completed', cjson.encode(ticket.response)} end
  ticket.response = cjson.decode(ARGV[3])
end
redis.call('HSET', KEYS[1], 'watcherToolCalls', cjson.encode(calls))
return {ARGV[1] == 'admit' and 'accepted' or 'claimed'}
`;

export class RedisWatcherToolTickets {
  constructor(private readonly redis: RedisClient) {}
  async count(invocationId: string): Promise<number> {
    const raw = await this.redis.hget(AuthInvocationKeys.record(invocationId), 'watcherToolCalls');
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  }
  async has(invocationId: string, callId: string): Promise<boolean> {
    const raw = await this.redis.hget(AuthInvocationKeys.record(invocationId), 'watcherToolCalls');
    return raw ? (JSON.parse(raw) as Array<{ id?: string }>).some((ticket) => ticket.id === callId) : false;
  }
  async admit(invocationId: string, callId: string, toolName: string): Promise<'accepted' | 'replayed' | 'exhausted'> {
    const [kind] = await this.update(invocationId, 'admit', callId, toolName, WATCHER_TOOL_ROUTES[toolName]?.[0] ?? '');
    return kind === 'accepted' || kind === 'replayed' ? kind : 'exhausted';
  }
  async claim(invocationId: string, callId: string, route: string, hash: string): Promise<WatcherTicketClaim> {
    const [kind, raw] = await this.update(invocationId, 'claim', callId, route, hash);
    if (kind === 'completed') return { kind, response: JSON.parse(raw!) as NonNullable<WatcherToolTicket['response']> };
    return { kind: kind === 'claimed' || kind === 'in_progress' ? kind : 'denied' };
  }
  async complete(
    invocationId: string,
    callId: string,
    response: NonNullable<WatcherToolTicket['response']>,
  ): Promise<void> {
    await this.update(invocationId, 'complete', callId, JSON.stringify(response), '');
  }
  private async update(invocationId: string, ...args: string[]): Promise<string[]> {
    return (await this.redis.eval(UPDATE, 1, AuthInvocationKeys.record(invocationId), ...args)) as string[];
  }
}
