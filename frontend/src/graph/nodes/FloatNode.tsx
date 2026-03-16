import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { useState, useCallback } from 'react';

const PORTS = [{ name: 'out', dir: 'out' as const, type: 'float' as const }];

function formatFloat(n: number): string {
  // 항상 소수점 이하 최소 1자리 표시
  const s = String(n);
  return s.includes('.') ? s : s + '.0';
}

function FloatNodeComponent({ node, onPortValueChange }: NodeComponentProps) {
  const val = (node.portValues?.out as number) ?? 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = useCallback((raw: string) => {
    const num = raw === '' ? 0 : parseFloat(raw);
    onPortValueChange?.(node.id, 'out', isNaN(num) ? 0 : num);
  }, [node.id, onPortValueChange]);

  return (
    <>
      <div className="ng-node-header"><span className="ng-node-title">{node.title}</span></div>
      <div className="ng-input-node-body">
        <input type="text" inputMode="decimal" className="ng-input-node-field ng-interactive"
          value={editing ? draft : formatFloat(val)}
          onFocus={e => { setEditing(true); setDraft(e.target.value); }}
          onChange={e => {
            const raw = e.target.value;
            // 숫자, 소수점, 마이너스만 허용
            if (raw !== '' && !/^-?\d*\.?\d*$/.test(raw)) return;
            setDraft(raw);
            commit(raw);
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onMouseDown={e => e.stopPropagation()} />
      </div>
      <PortRow nodeId={node.id} ports={PORTS} dir="out" />
    </>
  );
}

registerNode('float', {
  label: 'Float', category: 'Input', dataOnly: true, ports: PORTS,
  defaultConfig: {
    title: 'Float', status: 'completed', portValues: { out: 0.0 },
    menuTag: { en: 'Number', ko: '실수' },
    description: { en: 'Floating point number input', ko: '실수 입력값' },
  },
  component: FloatNodeComponent,
});
