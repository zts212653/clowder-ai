import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastContainer } from '@/components/ToastContainer';
import { apiFetch } from '@/utils/api-client';
import '@/app/globals.css';

function ConnectionNoticeProof() {
  const [status, setStatus] = useState('pending');
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
      <label htmlFor="message">Message</label>
      <textarea id="message" />
      <output>{status}</output>
      <ToastContainer />
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<ConnectionNoticeProof />);
