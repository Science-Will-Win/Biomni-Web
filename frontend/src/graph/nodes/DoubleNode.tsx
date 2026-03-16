import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { useState, useCallback } from 'react';

const PORTS = [{ name: 'out', dir: 'out' as const, type: 'double' as const, label: 'Value' }];

function formatDouble(n: number): string {
  const s = String(n);
  return s.includes('.') ? s : s + '.0';
}

function DoubleNodeComponent({ node, onPortValueChange }: NodeComponentProps) {
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
          value={editing ? draft : formatDouble(val)}
          onFocus={e => { setEditing(true); setDraft(e.target.value); }}
          onChange={e => {
            const raw = e.target.value;
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

registerNode('double_value', {
  label: 'Double', category: 'Input', dataOnly: true, ports: PORTS,
  defaultConfig: {
    title: 'Double', status: 'completed', portValues: { out: 0.0 },
    menuTag: { en: 'Number', ko: '숫자' },
    description: { en: '64-bit precision floating point', ko: '64비트 정밀도 실수' },
  },
  component: DoubleNodeComponent,
});
