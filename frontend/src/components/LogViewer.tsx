import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { LogStep } from '../types';

interface LogViewerProps {
  logs: LogStep[];
}

export const LogViewer: React.FC<LogViewerProps> = ({ logs }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!logs || logs.length === 0) return null;

  return (
    <div className="mt-2 border rounded-md border-gray-200 bg-gray-50 overflow-hidden text-left">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2">
          <Terminal size={14} />
          Biomni Process ({logs.length} steps)
        </span>
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      
      {isOpen && (
        <div className="p-2 space-y-2 max-h-60 overflow-y-auto bg-gray-900 text-green-400 text-xs font-mono rounded-b-md">
          {logs.map((log, idx) => (
            <div key={idx} className="border-b border-gray-700 pb-2 last:border-0">
              <div className="font-bold text-yellow-400">Step {idx + 1}</div>
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(log, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};