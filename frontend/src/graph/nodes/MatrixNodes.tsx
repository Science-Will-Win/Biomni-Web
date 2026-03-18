// Matrix 2x2, 3x3, 4x4 input nodes
import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { useState } from 'react';

function formatFloat(n: number): string {
  const s = String(n);
  return s.includes('.') ? s : s + '.0';
}

function MatrixInput({ node, size, onPortValueChange }: NodeComponentProps & { size: number }) {
  const total = size * size;
  const val = (node.portValues?.out as number[]) ?? new Array(total).fill(0);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  return (
    <>
      <div className="ng-node-header"><span className="ng-node-title">{node.title}</span></div>
      <div className="ng-input-node-body" style={{ display: 'grid', gridTemplateColumns: `repeat(${size}, 1fr)`, gap: 3 }}>
        {Array.from({ length: total }, (_, i) => (
          <input key={i} type="text" inputMode="decimal" className="ng-input-node-field ng-interactive"
            style={{ textAlign: 'center', padding: '2px 1px', fontSize: 10 }}
            value={editIdx === i ? draft : formatFloat(val[i] ?? 0)}
            onFocus={e => { setEditIdx(i); setDraft(e.target.value); }}
            onChange={e => {
              const raw = e.target.value;
              if (raw !== '' && !/^-?\d*\.?\d*$/.test(raw)) return;
              setDraft(raw);
              const next = [...val];
              next[i] = raw === '' ? 0 : (parseFloat(raw) || 0);
              onPortValueChange?.(node.id, 'out', next);
            }}
            onBlur={() => setEditIdx(null)}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onMouseDown={e => e.stopPropagation()} />
        ))}
      </div>
    </>
  );
}

function identity(size: number): number[] {
  const m = new Array(size * size).fill(0);
  for (let i = 0; i < size; i++) m[i * size + i] = 1;
  return m;
}

const M_PORTS = [{ name: 'out', dir: 'out' as const, type: 'matrix' as const }];

registerNode('matrix2', {
  label: 'Matrix 2x2', category: 'Input', dataOnly: true, ports: M_PORTS,
  defaultConfig: {
    title: 'Matrix 2x2', status: 'completed', portValues: { out: identity(2) },
    menuTag: { en: 'Matrix', ko: '행렬' },
    description: { en: '2x2 matrix input', ko: '2x2 행렬' },
  },
  component: (props: NodeComponentProps) => (
    <><MatrixInput {...props} size={2} /><PortRow nodeId={props.node.id} ports={M_PORTS} dir="out" /></>
  ),
});

registerNode('matrix3', {
  label: 'Matrix 3x3', category: 'Input', dataOnly: true, ports: M_PORTS,
  defaultConfig: {
    title: 'Matrix 3x3', status: 'completed', portValues: { out: identity(3) },
    menuTag: { en: 'Matrix', ko: '행렬' },
    description: { en: '3x3 matrix input', ko: '3x3 행렬' },
  },
  component: (props: NodeComponentProps) => (
    <><MatrixInput {...props} size={3} /><PortRow nodeId={props.node.id} ports={M_PORTS} dir="out" /></>
  ),
});

registerNode('matrix4', {
  label: 'Matrix 4x4', category: 'Input', dataOnly: true, ports: M_PORTS,
  defaultConfig: {
    title: 'Matrix 4x4', status: 'completed', portValues: { out: identity(4) },
    menuTag: { en: 'Matrix', ko: '행렬' },
    description: { en: '4x4 matrix input', ko: '4x4 행렬' },
  },
  component: (props: NodeComponentProps) => (
    <><MatrixInput {...props} size={4} /><PortRow nodeId={props.node.id} ports={M_PORTS} dir="out" /></>
  ),
});
