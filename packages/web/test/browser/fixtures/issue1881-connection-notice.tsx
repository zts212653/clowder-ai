import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastContainer } from '@/components/ToastContainer';
import { apiFetch } from '@/utils/api-client';
import '@/app/globals.css';

function ConnectionNoticeProof() {
  const [status, setStatus] = useState('pending');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    const poll = () =>
      void apiFetch('/api/threads/fixture/active-pane').then(
        () => setStatus('connected'),
        () => setStatus('offline'),
      );
    poll();
    const interval = setInterval(poll, 5_000);
    return () => clearInterval(interval);
  }, []);
  return (
    <main>
      <h1>Connection notice lifecycle — isolated component proof</h1>
      <section aria-label="Composer" style={{ position: 'fixed', bottom: 16, right: 16, width: 500, height: 140 }}>
        <label htmlFor="message">Message</label>
        <textarea id="message" style={{ width: 500, height: 140, background: 'white', border: '1px solid' }} />
        <button type="button" onClick={() => setSent(true)} style={{ position: 'absolute', bottom: 25, right: 40 }}>
          Send
        </button>
        <span>{sent ? 'Sent' : 'Draft'}</span>
      </section>
      <output aria-label="Connection state">{status}</output>
      <ToastContainer />
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<ConnectionNoticeProof />);
