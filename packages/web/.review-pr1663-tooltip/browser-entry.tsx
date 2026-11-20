import { createRoot } from 'react-dom/client';
import { SectionGroup } from '@/components/ThreadSidebar/SectionGroup';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

const paths = ['C:\\team-a\\demo', 'D:\\team-b\\demo'];
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 24 }}>
    <div id="sidebar" data-shell-sidebar="v2" style={{ width: 300, padding: 8 }}>
      {paths.map((projectPath, index) => (
        <SectionGroup key={projectPath} label="demo" projectPath={projectPath}
          count={1} isCollapsed={false} onToggle={() => {}}>
          <div style={{ padding: '4px 16px' }}>Conversation {index + 1}</div>
        </SectionGroup>
      ))}
      <SectionGroup label="Virtual" count={0} isCollapsed={false} onToggle={() => {}}>{null}</SectionGroup>
      <SectionGroup label="Default" projectPath="default" count={0} isCollapsed={false} onToggle={() => {}}>{null}</SectionGroup>
    </div>
  </main>,
);
