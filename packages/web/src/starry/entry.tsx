import { createRoot } from 'react-dom/client';
import StarryPage from './page';
import '../app/globals.css';

createRoot(document.getElementById('starry-root')!).render(<StarryPage />);
