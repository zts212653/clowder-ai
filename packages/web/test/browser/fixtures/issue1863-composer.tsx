import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatInput } from '@/components/ChatInput';
import { ChatReferenceScope } from '@/components/chat-references/ChatReferenceScope';
import { MarkdownContent } from '@/components/MarkdownContent';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { useThemeStore } from '@/stores/themeStore';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

// An isolated component preview. Only the host and submission boundary are fixtures.
// The textarea, draft lifecycle, edit handlers, themes and Markdown rendering are production code.
writeShellLanguage('zh');
document.documentElement.dataset.shell = 'v2';
document.documentElement.style.setProperty('--font-sans', 'ui-sans-serif, system-ui, sans-serif');
primeCoCreatorConfigCache({
  name: '枫哥',
  aliases: [],
  mentionPatterns: [],
  color: { primary: '#6B5443', secondary: '#E9DCCF' },
});
useChatStore.setState({ currentThreadId: '', currentProjectPath: '/preview' });

function Preview() {
  const params = new URLSearchParams(location.search);
  const [classic, setClassic] = useState(params.get('classic') === '1');
  const [unmapped, setUnmapped] = useState(0);
  useEffect(() => {
    const read = () =>
      setUnmapped(Number(document.querySelector('[data-unmapped]')?.getAttribute('data-unmapped') ?? 0));
    const observer = new MutationObserver(read);
    observer.observe(document.getElementById('root')!, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-unmapped'],
    });
    read();
    return () => observer.disconnect();
  }, []);
  const [threadId, setThreadId] = useState<string>();
  const [messages, setMessages] = useState<string[]>(JSON.parse(localStorage.getItem('issue1863:messages') ?? '[]'));
  const [seed, setSeed] = useState({
    id: 'initial',
    text: params.get('text') ?? 'https://github.com/meow-club/cat-cafe-map这是链接 这不是',
  });
  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--shell-work)',
        color: 'var(--shell-ink)',
        padding: '40px 16px',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <header style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 22 }}>发送之前，看清链接范围</h1>
          <p style={{ color: 'var(--shell-muted)', marginTop: 8 }}>在网址和说明之间插入空格或换行，观察标记变化。</p>
          <p style={{ color: 'var(--shell-muted)', fontSize: 12, marginTop: 8 }}>
            探索效果稿 · 标记表示这段源文本发送后会生成网页链接。发送仅进入本地演示消息，不调用猫猫。
          </p>
          {unmapped > 0 && (
            <p role="status">这个样例还有 {unmapped} 个网页链接未能定位；不能据此认为未标记部分不会成为链接。</p>
          )}
          <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
            <button
              type="button"
              onClick={() =>
                useThemeStore.getState().setActive(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
              }
            >
              明暗切换
            </button>
            <button type="button" onClick={() => setClassic(!classic)}>
              切换{classic ? '新版' : '经典'}
            </button>
            <button
              type="button"
              onClick={() =>
                setSeed({ id: crypto.randomUUID(), text: '[说明][ref]\n\n[ref]: https://example.com/中文?q=甲，乙' })
              }
            >
              引用式链接样例
            </button>
          </div>
        </header>
        <section data-testid="sent-messages" style={{ minHeight: 200, marginBottom: 32 }}>
          {messages.map((content, index) => (
            <ChatReferenceScope key={`${index}:${content}`} value="issue1863-preview-thread">
              <div style={{ padding: 16, marginBottom: 12, background: 'var(--shell-card)', borderRadius: 12 }}>
                <MarkdownContent content={content} />
              </div>
            </ChatReferenceScope>
          ))}
        </section>
        <ChatInput
          presentation={classic ? 'classic' : 'v2'}
          threadId={threadId}
          seed={seed}
          composerContext={<span style={{ fontSize: 12, color: 'var(--shell-muted)' }}>链接效果稿</span>}
          onSend={(content) => {
            const next = [...messages, content];
            setMessages(next);
            localStorage.setItem('issue1863:messages', JSON.stringify(next));
            setThreadId('issue1863-preview-thread');
            useChatStore.setState({ currentThreadId: 'issue1863-preview-thread' });
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <ThemeApplier />
    <Preview />
  </ThemeProvider>,
);
