import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { sendMessage } from './api';
import { LogViewer } from './components/LogViewer';

// [수정] 모든 타입을 여기서 재정의 (의존성 제거)
interface LogStep {
  step?: string;
  tool?: string;
  tool_input?: string;
  tool_output?: string;
  thought?: string;
  [key: string]: any;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  logs?: LogStep[];
  isLoading?: boolean;
}

function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: ChatMessage = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      setMessages(prev => [...prev, { role: 'assistant', content: '', isLoading: true }]);

      // api.ts의 함수 호출
      const data = await sendMessage(userMsg.content);

      setMessages(prev => {
        const newMsgs = [...prev];
        newMsgs.pop();
        return [...newMsgs, {
          role: 'assistant',
          content: data.response,
          // @ts-ignore (타입 불일치 경고 무시)
          logs: data.logs
        }];
      });
    } catch (error) {
      console.error(error);
      setMessages(prev => {
        const newMsgs = [...prev];
        newMsgs.pop();
        return [...newMsgs, { role: 'assistant', content: 'Error: Failed to connect to Biomni backend.' }];
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-white">
      <header className="bg-blue-600 text-white p-4 shadow-md flex items-center gap-2">
        <Bot size={24} />
        <h1 className="text-xl font-bold">Biomni Web Interface</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-gray-50">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
          >
            <div className={`p-2 rounded-full h-fit flex-shrink-0 ${msg.role === 'user' ? 'bg-blue-100' : 'bg-gray-200'}`}>
              {msg.role === 'user' ? <User size={20} className="text-blue-600" /> : <Bot size={20} className="text-gray-600" />}
            </div>

            <div className={`flex flex-col max-w-[80%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`p-4 rounded-lg shadow-sm text-sm text-left ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white text-gray-800 border'
                }`}>
                {msg.isLoading ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={16} />
                    <span>Biomni is thinking...</span>
                  </div>
                ) : (
                  <div className="prose prose-sm max-w-none dark:prose-invert break-words">
                    {/* 2. ReactMarkdown에서는 className을 뺍니다. */}
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>

              {msg.role === 'assistant' && !msg.isLoading && msg.logs && (
                <div className="w-full">
                  {/* @ts-ignore */}
                  <LogViewer logs={msg.logs} />
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="p-4 bg-white border-t border-gray-200">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Biomni a scientific question..."
            disabled={isLoading}
            className="flex-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-blue-600 text-white p-3 rounded-lg hover:bg-blue-700 disabled:bg-blue-300 transition-colors flex items-center justify-center w-12 flex-shrink-0"
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <Send />}
          </button>
        </div>
      </form>
    </div>
  );
}

export default App;