import { ChatArea } from '../../components/Chat/ChatArea.js';
import { useUiStore } from '../../stores/ui.js';

export function ChatView(): JSX.Element {
  const model = useUiStore((s) => s.model);
  const setModel = useUiStore((s) => s.setModel);

  return <ChatArea selectedModel={model} onModelChange={setModel} />;
}
