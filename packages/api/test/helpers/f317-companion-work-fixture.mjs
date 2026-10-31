import './setup-cat-registry.js';
import assert from 'node:assert/strict';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.ts';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.ts';
import { F232PreparedArtifactReader } from '../../src/domains/growing/F232PreparedArtifactReader.ts';

export async function workFixture(_t, { artifactWorkLineage } = {}) {
  const tasks = new TaskStore(),
    messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', '回家清单', '/synthetic/work');
  const publications = new F232PreparedArtifactReader({ messages });
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { artifactReader: publications });
  const options = {
    ownerUserId: 'owner',
    projectPath: '/synthetic/work',
    ...(artifactWorkLineage ? { artifactLineage: artifactWorkLineage } : {}),
    threads,
    tasks,
    messages,
    assertCurrent: async () => {},
  };
  async function admit(key = 'checklist', userId = 'owner') {
    const source = messages.append({
      userId,
      threadId: thread.id,
      from: { kind: 'user', userId },
      content: '请帮我做一份回家清单',
      mentions: [],
      timestamp: Date.now(),
    });
    const result = await lifecycle.admitOrResume({
      task: {
        userId,
        threadId: thread.id,
        title: key,
        why: '主人明确托付',
        createdBy: 'codex-sol',
        ownerCatId: 'codex-sol',
      },
      admission: {
        basis: 'explicit_entrustment',
        idempotencyKey: key,
        sourceRefs: [`message:${source.id}`],
        intendedOutcome: '可打开并接着修改的清单',
      },
      closure: { condition: '完成清单及修改', expectedSignal: 'checklist-delivered' },
    });
    assert.ok(result.subjectRef);
    return result.subjectRef.slice('task:work:'.length);
  }
  function publish(name, timestamp = Date.now()) {
    return messages.append({
      userId: 'owner',
      threadId: thread.id,
      from: { kind: 'agent', catId: 'codex-sol' },
      content: `交付 ${name}`,
      mentions: [],
      timestamp,
      extra: {
        rich: {
          v: 1,
          blocks: [
            { kind: 'file', v: 1, id: name, fileName: name, url: `/uploads/${name}`, mimeType: 'text/markdown' },
          ],
        },
      },
    });
  }
  return { options, tasks, messages, threads, thread, lifecycle, admit, publish };
}
