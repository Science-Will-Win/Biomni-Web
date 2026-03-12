import { useRef } from 'react';
import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';

const PORTS = [{ name: 'out', dir: 'out' as const, type: 'data' as const }];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileData {
  fileName?: string;
  fileSize?: number;
  textContent?: string;
  name?: string;
  size?: number;
}

function DataNodeComponent({ node, onPortValueChange }: NodeComponentProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const val = node.portValues?.out as FileData | null;
  const fileName = val?.fileName || val?.name;
  const fileSize = val?.fileSize || val?.size || 0;
  const textContent = val?.textContent;

  const handleBrowse = (e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Read text content for preview
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = typeof ev.target?.result === 'string' ? ev.target.result : '';
      onPortValueChange?.(node.id, 'out', {
        fileName: file.name,
        fileSize: file.size,
        textContent: text.slice(0, 500),
      });
    };
    reader.readAsText(file);
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPortValueChange?.(node.id, 'out', null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <>
      <div className="ng-node-header"><span className="ng-node-title">{node.title}</span></div>
      <div className="ng-data-body">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xml,.json,.txt,.pdf,.doc,.docx,.xlsx,.xls"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        {fileName ? (
          <>
            <div className="ng-data-file-info">
              <span className="ng-data-file-name">{fileName}</span>
              <span className="ng-data-file-size">{formatFileSize(fileSize)}</span>
              <button className="ng-data-remove-btn ng-interactive" title="Remove"
                onClick={handleRemove} onMouseDown={e => e.stopPropagation()}>
                &times;
              </button>
            </div>
            {textContent && (
              <div className="ng-data-preview">
                {textContent.length > 200 ? textContent.slice(0, 200) + '...' : textContent}
              </div>
            )}
          </>
        ) : (
          <button className="ng-data-browse-btn ng-interactive"
            onClick={handleBrowse} onMouseDown={e => e.stopPropagation()}>
            Browse File
          </button>
        )}
      </div>
      <PortRow nodeId={node.id} ports={PORTS} dir="out" />
    </>
  );
}

registerNode('data', {
  label: 'Data', category: 'Data', dataOnly: true, ports: PORTS,
  defaultConfig: {
    title: 'Data', status: 'completed', portValues: { out: null },
    menuTag: { en: 'Data', ko: '데이터' },
    description: { en: 'Load data file (CSV, JSON, PDF, etc.)', ko: '데이터 파일 로드' },
  },
  component: DataNodeComponent,
});
