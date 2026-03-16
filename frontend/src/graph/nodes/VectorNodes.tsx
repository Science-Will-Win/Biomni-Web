// Vector2, Vector3, Vector4 input nodes
import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { useState } from 'react';

const LABELS = ['X', 'Y', 'Z', 'W'];

function formatFloat(n: number): string {
  const s = String(n);
  return s.includes('.') ? s : s + '.0';
}

function VectorInput({ node, size, onPortValueChange }: NodeComponentProps & { size: number }) {
  const val = (node.portValues?.out as number[]) ?? new Array(size).fill(0);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  return (
    <>
      <div className="ng-node-header"><span className="ng-node-title">{node.title}</span></div>
      <div className="ng-input-node-body" style={{ display: 'grid', gridTemplateColumns: `repeat(${size}, 1fr)`, gap: 4 }}>
        {Array.from({ length: size }, (_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'center' }}>{LABELS[i]}</span>
            <input type="text" inputMode="decimal" className="ng-input-node-field ng-interactive"
              style={{ textAlign: 'center', padding: '3px 2px' }}
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
          </div>
        ))}
      </div>
    </>
  );
}

// Vector2
const V2_PORTS = [{ name: 'out', dir: 'out' as const, type: 'vector2' as const }];
registerNode('vector2', {
  label: 'Vector2', category: 'Input', dataOnly: true, ports: V2_PORTS,
  defaultConfig: {
    title: 'Vector2', status: 'completed', portValues: { out: [0, 0] },
    menuTag: { en: 'Vector', ko: '벡터' },
    description: { en: '2D vector (X, Y)', ko: '2D 벡터' },
  },
  component: (props: NodeComponentProps) => (
    <><VectorInput {...props} size={2} /><PortRow nodeId={props.node.id} ports={V2_PORTS} dir="out" /></>
  ),
});

// Vector3
const V3_PORTS = [{ name: 'out', dir: 'out' as const, type: 'vector3' as const }];
registerNode('vector3', {
  label: 'Vector3', category: 'Input', dataOnly: true, ports: V3_PORTS,
  defaultConfig: {
    title: 'Vector3', status: 'completed', portValues: { out: [0, 0, 0] },
    menuTag: { en: 'Vector', ko: '벡터' },
    description: { en: '3D vector (X, Y, Z)', ko: '3D 벡터' },
  },
  component: (props: NodeComponentProps) => (
    <><VectorInput {...props} size={3} /><PortRow nodeId={props.node.id} ports={V3_PORTS} dir="out" /></>
  ),
});

// Vector4
const V4_PORTS = [{ name: 'out', dir: 'out' as const, type: 'vector4' as const }];
registerNode('vector4', {
  label: 'Vector4', category: 'Input', dataOnly: true, ports: V4_PORTS,
  defaultConfig: {
    title: 'Vector4', status: 'completed', portValues: { out: [0, 0, 0, 0] },
    menuTag: { en: 'Vector', ko: '벡터' },
    description: { en: '4D vector (X, Y, Z, W)', ko: '4D 벡터' },
  },
  component: (props: NodeComponentProps) => (
    <><VectorInput {...props} size={4} /><PortRow nodeId={props.node.id} ports={V4_PORTS} dir="out" /></>
  ),
});
