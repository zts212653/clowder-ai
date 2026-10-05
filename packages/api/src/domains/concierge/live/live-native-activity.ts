import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';

/** The same native event stream drives status and the companion's pet motion. */
export class LiveNativeActivity {
  private readonly tools = new Set<string>();
  private readonly reasoning = new Set<string>();

  get state(): 'none' | 'reasoning' | 'tool_running' {
    return this.tools.size ? 'tool_running' : this.reasoning.size ? 'reasoning' : 'none';
  }

  clear(): void {
    this.tools.clear();
    this.reasoning.clear();
  }

  observe(message: CodexAppServerJsonObject, activeTurnId: string | undefined): void {
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      this.clear();
      return;
    }
    const params = message.params as Record<string, unknown> | undefined;
    if (!activeTurnId || !params || params.turnId !== activeTurnId) return;
    if (message.method !== 'item/started' && message.method !== 'item/completed') return;
    const item = params.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const { id, type } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length > 160) return;
    const target = type === 'mcpToolCall' ? this.tools : type === 'reasoning' ? this.reasoning : null;
    if (!target) return;
    if (message.method === 'item/completed') target.delete(id);
    else if (target.size < 64) target.add(id);
  }
}
