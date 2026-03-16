import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { useState, useCallback } from 'react';

const PORTS = [{ name: 'out', dir: 'out' as const, type: 'int' as const }];

function IntegerNodeComponent({ node, onPortValueChange }: NodeComponentProps) {
  const val = (node.portValues?.out as number) ?? 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = useCallback((raw: string) => {
    const num = raw === '' ? 0 : parseInt(raw);
    onPortValueChange?.(node.id, 'out', isNaN(num) ? 0 : num);
  }, [node.id, onPortValueChange]);

  return (
    <>
      <div className="ng-node-header"><span className="ng-node-title">{node.title}</span></div>
      <div className="ng-input-node-body">
        <input type="text" inputMode="numeric" className="ng-input-node-field ng-interactive"
          value={editing ? draft : String(val)}
          onFocus={e => { setEditing(true); setDraft(e.target.value); }}
          onChange={e => {
            const raw = e.target.value;
            // 정수만 허용 (마이너스, 숫자)
            if (raw !== '' && !/^-?\d*$/.test(raw)) return;
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

registerNode('integer', {
  label: 'Integer', category: 'Input', dataOnly: true, ports: PORTS,
  defaultConfig: {
    title: 'Integer', status: 'completed', portValues: { out: 0 },
    menuTag: { en: 'Number', ko: '정수' },
    description: { en: 'Integer number input', ko: '정수 입력값' },
  },
  component: IntegerNodeComponent,
});
