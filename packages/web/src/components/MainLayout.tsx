/**
 * 主页面布局：Sidebar + ChatArea。
 */
import { Sidebar } from './Sidebar/Sidebar.js';
import { ChatArea } from './Chat/ChatArea.js';

export function MainLayout(): JSX.Element {
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <Sidebar />
      <ChatArea />
    </div>
  );
}
