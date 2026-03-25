'use client';

import { useCallback, useMemo } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigSnapshot = any;

export function isCommandInvocation(input: string, command: string): boolean {
  if (!input.startsWith(command)) return false;
  if (input.length === command.length) return true;
  return /\s/.test(input.charAt(command.length));
}

/** Format ConfigSnapshot into readable multi-line text for /config display */
function formatConfigForDisplay(config: ConfigSnapshot): string {
  const lines: string[] = ['[配置] Clowder AI 运行配置', ''];

  // Per-cat budgets first (the actual limits used)
  if (config.perCatBudgets) {
    lines.push('Per-Cat 上下文预算');
    for (const [catId, budget] of Object.entries(config.perCatBudgets)) {
      const b = budget as {
        maxPromptTokens: number;
        maxContextTokens: number;
        maxMessages: number;
        maxContentLengthPerMsg: number;
      };
      lines.push(
        `  ${catId}: prompt ${(b.maxPromptTokens / 1000).toFixed(0)}k, context ${(b.maxContextTokens / 1000).toFixed(0)}k, ${b.maxMessages} msgs, ${b.maxContentLengthPerMsg}/msg`,
      );
    }
    lines.push('');
  }

  // Legacy context section (deprecated)
  if (config.context) {
    lines.push('上下文默认值 (deprecated, see per-cat)');
    lines.push(`  历史条数: ${config.context.maxMessages}`);
    lines.push(`  每条截断: ${config.context.maxContentLength} 字符`);
    lines.push(`  总上下文: ${config.context.maxTotalChars} 字符`);
    lines.push(`  总 prompt: ${config.context.maxPromptTokens} 字符`);
    if (config.context.note) {
      lines.push(`  注: ${config.context.note}`);
    }
    lines.push('');
  }

  if (config.cli) {
    lines.push('CLI');
    lines.push(`  超时: ${config.cli.timeoutMs / 1000}s`);
    lines.push(`  强制终止: ${config.cli.killGraceMs / 1000}s`);
    lines.push('');
  }

  if (config.storage) {
    lines.push('存储');
    lines.push(`  消息 TTL: ${config.storage.messageTTL}`);
    lines.push(`  对话 TTL: ${config.storage.threadTTL}`);
    lines.push(`  任务 TTL: ${config.storage.taskTTL}`);
    lines.push(`  最大消息数: ${config.storage.maxMessages}`);
    lines.push(`  最大对话数: ${config.storage.maxThreads}`);
    lines.push('');
  }

  if (config.upload) {
    lines.push('上传');
    lines.push(`  最大文件: ${config.upload.maxFileSize}`);
    lines.push(`  最大数量: ${config.upload.maxFiles}`);
    lines.push('');
  }

  if (config.server) {
    lines.push('服务器');
    lines.push(`  地址: ${config.server.host}:${config.server.port}`);
    lines.push(`  存储: ${config.server.redis === 'connected' ? 'Redis' : '内存'}`);
    lines.push('');
  }

  if (config.cats) {
    lines.push('猫猫配置');
    for (const [id, cat] of Object.entries(config.cats)) {
      const c = cat as { displayName: string; provider: string; model: string; mcpSupport: boolean };
      lines.push(`  ${c.displayName} (${id}): ${c.provider}/${c.model} ${c.mcpSupport ? '[MCP]' : ''}`);
    }
    lines.push('');
  }

  if (config.a2a) {
    lines.push('A2A 猫猫互调');
    lines.push(`  启用: ${config.a2a.enabled ? '是' : '否'}`);
    lines.push(`  最大深度: ${config.a2a.maxDepth}`);
    lines.push('');
  }

  if (config.memory) {
    lines.push('显式记忆 (F3-lite)');
    lines.push(`  启用: ${config.memory.enabled ? '是' : '否'}`);
    lines.push(`  每对话最大条数: ${config.memory.maxKeysPerThread}`);
    lines.push('');
  }

  if (config.governance) {
    lines.push('治理 (4-D-lite)');
    lines.push(`  降级策略: ${config.governance.degradationEnabled ? '启用' : '禁用'}`);
    lines.push(`  Done 超时: ${config.governance.doneTimeoutMs / 1000}s`);
    lines.push(`  心跳间隔: ${config.governance.heartbeatIntervalMs / 1000}s`);
    lines.push('');
  }

  if (config.deliberate) {
    lines.push('两轮思考 (4-E)');
    lines.push(`  状态: ${config.deliberate.status === 'types_only' ? '类型预埋' : '已实现'}`);
  }

  return lines.join('\n');
}

/**
 * Hook for processing chat commands (e.g., /config).
 * Returns true if the input was a command that was handled.
 */
export function useChatCommands() {
  const { addMessage } = useChatStore();
  const { cats } = useCatData();

  // Build dynamic mention pattern → catId resolver from cat data
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _mentionResolver = useMemo(() => {
    const patternToCatId = new Map<string, string>();
    for (const cat of cats) {
      for (const pattern of cat.mentionPatterns) {
        // Strip leading @ for matching
        const text = pattern.startsWith('@') ? pattern.slice(1) : pattern;
        patternToCatId.set(text.toLowerCase(), cat.id);
      }
      // Also match by catId directly
      patternToCatId.set(cat.id.toLowerCase(), cat.id);
    }
    // Build regex from all patterns
    const allPatterns = [...patternToCatId.keys()].sort((a, b) => b.length - a.length); // longest first
    const regex =
      allPatterns.length > 0
        ? new RegExp(`@(${allPatterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
        : /@(opus|codex|gemini|dare|dare-agent)/gi; // fallback
    return { regex, resolve: (name: string) => patternToCatId.get(name.toLowerCase()) };
  }, [cats]);

  const processCommand = useCallback(
    async (input: string, overrideThreadId?: string): Promise<boolean> => {
      const trimmed = input.trim();
      /** Resolve effective threadId — override (from split-pane) or store default */
      const getThreadId = () => overrideThreadId ?? useChatStore.getState().currentThreadId;
      const addSystemError = (content: string) => {
        addMessage({
          id: `err-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content,
          timestamp: Date.now(),
        });
      };
      // /help — open Hub to commands tab (F12)
      if (trimmed === '/help') {
        useChatStore.getState().openHub('commands');
        return true;
      }

      // /config command — open hub or hot-update
      if (isCommandInvocation(trimmed, '/config')) {
        const configArgs = trimmed.slice('/config'.length).trim();

        // /config (no args) — open Hub to system tab (F12)
        if (!configArgs) {
          useChatStore.getState().openHub('system');
          return true;
        }

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        // /config set <key> <value> — hot-update (F4)
        if (configArgs.startsWith('set ')) {
          const parts = configArgs.slice(4).trim().split(/\s+/, 2);
          if (parts.length < 2) {
            addSystemError('用法: /config set <key> <value>\n可更新: cli.timeoutMs, a2a.maxDepth');
            return true;
          }
          try {
            const res = await apiFetch(`/api/config`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: parts[0], value: parts[1] }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => null);
              throw new Error(body?.error ?? `Server error: ${res.status}`);
            }
            const data = await res.json();
            addMessage({
              id: `config-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `[已更新] ${parts[0]} = ${parts[1]}\n\n${formatConfigForDisplay(data.config)}`,
              timestamp: Date.now(),
            });
          } catch (err) {
            addSystemError(`配置更新失败: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          return true;
        }

        // Other /config subcommands (unknown) — show usage hint
        addMessage({
          id: `err-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `未知 /config 子命令: ${configArgs}\n用法: /config 或 /config set <key> <value>`,
          timestamp: Date.now(),
        });
        return true;
      }

      // /remember <key> <value> — store memory
      if (trimmed.startsWith('/remember ')) {
        const rest = trimmed.slice('/remember '.length).trim();
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx <= 0) {
          addSystemError('用法: /remember <key> <value>');
          return true;
        }
        const key = rest.slice(0, spaceIdx);
        const value = rest.slice(spaceIdx + 1);

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        try {
          const threadId = getThreadId();
          const res = await apiFetch(`/api/memory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId, key, value, updatedBy: 'user' }),
          });
          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          addMessage({
            id: `mem-${Date.now()}`,
            type: 'system',
            variant: 'info',
            content: `[记忆] 已记住: ${key}`,
            timestamp: Date.now(),
          });
        } catch (err) {
          addSystemError(`记忆保存失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // /recall [key] — read memory
      if (isCommandInvocation(trimmed, '/recall')) {
        const rest = trimmed.slice('/recall'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        try {
          const threadId = getThreadId();
          const path = rest
            ? `/api/memory?threadId=${encodeURIComponent(threadId)}&key=${encodeURIComponent(rest)}`
            : `/api/memory?threadId=${encodeURIComponent(threadId)}`;

          const res = await apiFetch(path);

          if (rest) {
            // Single key lookup
            if (res.status === 404) {
              addMessage({
                id: `mem-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `[检索] 未找到: ${rest}`,
                timestamp: Date.now(),
              });
            } else if (!res.ok) {
              throw new Error(`Server error: ${res.status}`);
            } else {
              const entry = await res.json();
              addMessage({
                id: `mem-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `[检索] ${entry.key}: ${entry.value}`,
                timestamp: Date.now(),
              });
            }
          } else {
            // List all
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            const data = await res.json();
            const entries = data.entries as Array<{ key: string; value: string }>;
            if (entries.length === 0) {
              addMessage({
                id: `mem-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: '[检索] 此对话暂无记忆',
                timestamp: Date.now(),
              });
            } else {
              const lines = entries.map((e) => `  ${e.key}: ${e.value}`).join('\n');
              addMessage({
                id: `mem-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `[检索] 对话记忆 (${entries.length} 条)\n${lines}`,
                timestamp: Date.now(),
              });
            }
          }
        } catch (err) {
          addSystemError(`读取记忆失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // /evidence <query> — search project knowledge
      if (isCommandInvocation(trimmed, '/evidence')) {
        const query = trimmed.slice('/evidence'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        if (!query) {
          addMessage({
            id: `err-${Date.now()}`,
            type: 'system',
            variant: 'info',
            content: '用法: /evidence <搜索关键词>\n例: /evidence hindsight bank 设计',
            timestamp: Date.now(),
          });
          return true;
        }

        try {
          const res = await apiFetch(`/api/evidence/search?q=${encodeURIComponent(query)}`);
          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const data = (await res.json()) as {
            results: Array<{
              title: string;
              anchor: string;
              snippet: string;
              confidence: 'high' | 'mid' | 'low';
              sourceType: 'decision' | 'phase' | 'discussion' | 'commit';
            }>;
            degraded: boolean;
            degradeReason?: string;
          };

          addMessage({
            id: `evidence-${Date.now()}`,
            type: 'system',
            variant: 'evidence',
            content: `Evidence: ${query}`,
            evidence: data,
            timestamp: Date.now(),
          });
        } catch (err) {
          addSystemError(`证据检索失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // /approve <entryId> — approve a pending_review memory entry
      if (isCommandInvocation(trimmed, '/approve')) {
        const entryId = trimmed.slice('/approve'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        if (!entryId) {
          addMessage({
            id: `err-${Date.now()}`,
            type: 'system',
            variant: 'info',
            content: '用法: /approve <entryId>',
            timestamp: Date.now(),
          });
          return true;
        }

        try {
          const res = await apiFetch(`/api/memory/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId, action: 'approve', actor: 'user' }),
          });
          const data = await res.json();
          if (!res.ok) {
            addSystemError(`审批失败: ${data.error ?? res.status}`);
          } else {
            addMessage({
              id: `publish-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `[已审批] ${entryId}: ${data.previousStatus} → ${data.currentStatus}`,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          addSystemError(`审批请求失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // /archive <entryId> — archive a published memory entry
      if (isCommandInvocation(trimmed, '/archive')) {
        const entryId = trimmed.slice('/archive'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        if (!entryId) {
          addMessage({
            id: `err-${Date.now()}`,
            type: 'system',
            variant: 'info',
            content: '用法: /archive <entryId>',
            timestamp: Date.now(),
          });
          return true;
        }

        try {
          const res = await apiFetch(`/api/memory/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId, action: 'archive', actor: 'user' }),
          });
          const data = await res.json();
          if (!res.ok) {
            addSystemError(`归档失败: ${data.error ?? res.status}`);
          } else {
            addMessage({
              id: `publish-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `[已归档] ${entryId}: ${data.previousStatus} → ${data.currentStatus}`,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          addSystemError(`归档请求失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // /reflect <query> — LLM reflection on project knowledge
      if (isCommandInvocation(trimmed, '/reflect')) {
        const query = trimmed.slice('/reflect'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        if (!query) {
          addMessage({
            id: `err-${Date.now()}`,
            type: 'system',
            variant: 'info',
            content: '用法: /reflect <问题>\n例: /reflect 为什么我们选择 per-cat budgets？',
            timestamp: Date.now(),
          });
          return true;
        }

        try {
          const res = await apiFetch(`/api/reflect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
          });
          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const data = (await res.json()) as {
            reflection: string;
            degraded: boolean;
            degradeReason?: string;
          };

          if (data.degraded) {
            addMessage({
              id: `reflect-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `[警告] Hindsight 不可用 (${data.degradeReason ?? '未知'})，无法生成反思`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              id: `reflect-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `[反思] 结果\n━━━━━━━━━\n${data.reflection}`,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          addSystemError(`反思请求失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // /signals family — inbox/search/sources/stats
      if (isCommandInvocation(trimmed, '/signals')) {
        const signalArgs = trimmed.slice('/signals'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        if (!signalArgs || signalArgs === 'inbox') {
          try {
            const res = await apiFetch('/api/signals/inbox?limit=20');
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            const data = (await res.json()) as {
              items: Array<{ id: string; title: string; source: string; tier: number; fetchedAt: string }>;
            };

            if (data.items.length === 0) {
              addMessage({
                id: `signals-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: 'Signals inbox is empty',
                timestamp: Date.now(),
              });
            } else {
              const lines = data.items.map((item) => `- [${item.id}] ${item.title} (${item.source}/T${item.tier})`);
              addMessage({
                id: `signals-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `Signals inbox (${data.items.length})\n${lines.join('\n')}`,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            addMessage({
              id: `err-${Date.now()}`,
              type: 'system',
              content: `Signals inbox 请求失败: ${err instanceof Error ? err.message : 'Unknown'}`,
              timestamp: Date.now(),
            });
          }
          return true;
        }

        if (signalArgs.startsWith('search ')) {
          const query = signalArgs.slice('search '.length).trim();
          if (!query) {
            addMessage({
              id: `err-${Date.now()}`,
              type: 'system',
              content: '用法: /signals search <query>',
              timestamp: Date.now(),
            });
            return true;
          }

          try {
            const res = await apiFetch(`/api/signals/search?q=${encodeURIComponent(query)}&limit=20`);
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            const data = (await res.json()) as {
              total: number;
              items: Array<{ id: string; title: string; source: string; tier: number }>;
            };

            if (data.items.length === 0) {
              addMessage({
                id: `signals-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `No signal article matched query: ${query}`,
                timestamp: Date.now(),
              });
            } else {
              const lines = data.items.map((item) => `- [${item.id}] ${item.title} (${item.source}/T${item.tier})`);
              addMessage({
                id: `signals-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `Signal search results (${data.total})\n${lines.join('\n')}`,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            addMessage({
              id: `err-${Date.now()}`,
              type: 'system',
              content: `Signals search 请求失败: ${err instanceof Error ? err.message : 'Unknown'}`,
              timestamp: Date.now(),
            });
          }
          return true;
        }

        if (signalArgs === 'stats') {
          try {
            const res = await apiFetch('/api/signals/stats');
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            const data = (await res.json()) as {
              todayCount: number;
              weekCount: number;
              unreadCount: number;
            };

            addMessage({
              id: `signals-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `Signals stats: today=${data.todayCount}, week=${data.weekCount}, unread=${data.unreadCount}`,
              timestamp: Date.now(),
            });
          } catch (err) {
            addMessage({
              id: `err-${Date.now()}`,
              type: 'system',
              content: `Signals stats 请求失败: ${err instanceof Error ? err.message : 'Unknown'}`,
              timestamp: Date.now(),
            });
          }
          return true;
        }

        if (signalArgs.startsWith('sources')) {
          const sourceArgs = signalArgs.slice('sources'.length).trim();
          if (!sourceArgs) {
            try {
              const res = await apiFetch('/api/signals/sources');
              if (!res.ok) throw new Error(`Server error: ${res.status}`);
              const data = (await res.json()) as {
                sources: Array<{ id: string; enabled: boolean; tier: number; fetch: { method: string } }>;
              };

              const lines = data.sources.map((source) => {
                const state = source.enabled ? 'enabled' : 'disabled';
                return `- ${source.id} (${state}, T${source.tier}, ${source.fetch.method})`;
              });
              addMessage({
                id: `signals-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `Signal sources (${data.sources.length})\n${lines.join('\n')}`,
                timestamp: Date.now(),
              });
            } catch (err) {
              addMessage({
                id: `err-${Date.now()}`,
                type: 'system',
                content: `Signals sources 请求失败: ${err instanceof Error ? err.message : 'Unknown'}`,
                timestamp: Date.now(),
              });
            }
            return true;
          }

          const parts = sourceArgs.split(/\s+/);
          if (parts.length !== 2 || (parts[1] !== 'on' && parts[1] !== 'off')) {
            addMessage({
              id: `err-${Date.now()}`,
              type: 'system',
              content: '用法: /signals sources [sourceId on|off]',
              timestamp: Date.now(),
            });
            return true;
          }

          const sourceId = parts[0];
          const enabled = parts[1] === 'on';

          try {
            const res = await apiFetch(`/api/signals/sources/${encodeURIComponent(sourceId)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled }),
            });
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            const data = (await res.json()) as { source: { id: string; enabled: boolean } };

            addMessage({
              id: `signals-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `Signal source updated: ${data.source.id} ${data.source.enabled ? 'enabled' : 'disabled'}`,
              timestamp: Date.now(),
            });
          } catch (err) {
            addMessage({
              id: `err-${Date.now()}`,
              type: 'system',
              content: `Signals source update 失败: ${err instanceof Error ? err.message : 'Unknown'}`,
              timestamp: Date.now(),
            });
          }
          return true;
        }

        addMessage({
          id: `err-${Date.now()}`,
          type: 'system',
          content:
            '用法: /signals [inbox] | /signals search <query> | /signals sources [sourceId on|off] | /signals stats',
          timestamp: Date.now(),
        });
        return true;
      }

      // /tasks extract [N] — extract tasks from conversation
      if (trimmed.startsWith('/tasks extract')) {
        const rest = trimmed.slice('/tasks extract'.length).trim();
        const messageCount = rest ? parseInt(rest, 10) : undefined;

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        addMessage({
          id: `sysinfo-extract-${Date.now()}`,
          type: 'system',
          variant: 'info',
          content: '[检索] 正在从对话中提取任务...',
          timestamp: Date.now(),
        });

        try {
          const threadId = getThreadId();
          const res = await apiFetch(`/api/commands/extract-tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              threadId,
              userId: getUserId(),
              ...(messageCount && !Number.isNaN(messageCount) ? { messageCount } : {}),
            }),
          });

          if (!res.ok) throw new Error(`Server error: ${res.status}`);
          const data = (await res.json()) as { count: number; degraded: boolean; reason?: string };

          if (data.count === 0) {
            addMessage({
              id: `extract-result-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: '[任务] 未找到可提取的任务',
              timestamp: Date.now(),
            });
          } else {
            const degradeNote = data.degraded ? ` (模式匹配: ${data.reason ?? '未知'})` : '';
            addMessage({
              id: `extract-result-${Date.now()}`,
              type: 'system',
              variant: 'info',
              content: `[已提取] ${data.count} 个任务${degradeNote}`,
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          addSystemError(`任务提取失败: ${err instanceof Error ? err.message : 'Unknown'}`);
        }
        return true;
      }

      // ── /vote — F079 Voting System ──
      if (isCommandInvocation(trimmed, '/vote')) {
        const voteArgs = trimmed.slice('/vote'.length).trim();

        addMessage({
          id: `user-${Date.now()}`,
          type: 'user',
          content: trimmed,
          timestamp: Date.now(),
        });

        // /vote end — close current vote
        if (voteArgs === 'end' || voteArgs === 'close') {
          try {
            const threadId = getThreadId();
            const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote`, {
              method: 'DELETE',
            });
            if (res.status === 404) {
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: '当前没有活跃投票',
                timestamp: Date.now(),
              });
            } else if (!res.ok) {
              throw new Error(`Server error: ${res.status}`);
            } else {
              const data = await res.json();
              const r = data.result;
              // Use backend tally (works for both anonymous and named votes)
              const tallyObj = r.tally as Record<string, number> | undefined;
              const tallyText = tallyObj
                ? Object.entries(tallyObj)
                    .map(([opt, count]) => `  ${opt}: ${count} 票`)
                    .join('\n')
                : '  (无投票)';
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `投票已结束: ${r.question}\n${tallyText}`,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            addSystemError(`投票操作失败: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          return true;
        }

        // /vote status — query current vote
        if (voteArgs === 'status') {
          try {
            const threadId = getThreadId();
            const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote`);
            if (!res.ok) throw new Error(`Server error: ${res.status}`);
            const data = await res.json();
            if (data.vote) {
              const v = data.vote;
              // Use voteCount from backend (anonymous) or compute from votes (named)
              const voteCount = v.voteCount ?? Object.keys(v.votes).length;
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `当前投票: ${v.question}\n选项: ${v.options.join(' | ')}\n已投: ${voteCount} 票 | ${v.anonymous ? '匿名' : '实名'}\n截止: ${new Date(v.deadline).toLocaleTimeString()}`,
                timestamp: Date.now(),
              });
            } else {
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: '当前没有活跃投票\n用法: /vote <问题> <选项1> <选项2> [--anonymous] [--timeout 120]',
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            addSystemError(`查询投票失败: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          return true;
        }

        // /vote cast <option> — cast a vote
        if (voteArgs.startsWith('cast ')) {
          const option = voteArgs.slice('cast '.length).trim();
          try {
            const threadId = getThreadId();
            const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ option }),
            });
            if (res.status === 404) {
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: '当前没有活跃投票',
                timestamp: Date.now(),
              });
            } else if (res.status === 400) {
              const data = await res.json();
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'error',
                content: `投票失败: ${data.error ?? '无效选项'}`,
                timestamp: Date.now(),
              });
            } else if (!res.ok) {
              throw new Error(`Server error: ${res.status}`);
            } else {
              addMessage({
                id: `vote-${Date.now()}`,
                type: 'system',
                variant: 'info',
                content: `已投票: ${option}`,
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            addSystemError(`投票失败: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
          return true;
        }

        // Phase 2: /vote (no args or with start args) → open VoteConfigModal
        useChatStore.getState().setShowVoteModal(true);
        return true;
      }

      return false;
    },
    [addMessage],
  );

  return { processCommand };
}
