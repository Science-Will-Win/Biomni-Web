// Math operation nodes: Add, Subtract, Multiply, Divide, Power, Sqrt, Log
import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { NodeHeader } from '../components/NodeHeader';
import { PortRow } from '../components/PortRow';
import { PORT_COLORS } from '../port-types';
import type { PortDef } from '../types';
import { useState, useMemo } from 'react';
import { executeMathOp } from '../mathCompute';

// Shared port input field with proper type handling
function MathPortInput({ nodeId, portName, value, onChange }: {
  nodeId: string; portName: string; value: unknown;
  onChange?: (nodeId: string, portName: string, value: unknown) => void;
}) {
  const val = typeof value === 'number' ? value : 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  return (
    <input
      className="ng-port-default ng-interactive"
      type="text"
      inputMode="decimal"
      value={editing ? draft : String(val)}
      onFocus={e => { setEditing(true); setDraft(e.target.value); }}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw !== '' && !/^-?\d*\.?\d*$/.test(raw)) return;
        setDraft(raw);
        const num = raw === '' ? 0 : Number(raw);
        onChange?.(nodeId, portName, isNaN(num) ? 0 : num);
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

/** Format computed result for preview display */
function formatResult(v: unknown): string {
  if (typeof v === 'number') {
    if (!isFinite(v)) return v > 0 ? '∞' : '-∞';
    return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (Array.isArray(v)) return `[${v.map(x => typeof x === 'number' ? (Number.isInteger(x) ? x : x.toFixed(2)) : x).join(', ')}]`;
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

// Shared binary math node component — renders input fields with default values + result preview
function BinaryMathNode({ node, connectedPorts, onTitleChange, onPortValueChange, ports, tool }: NodeComponentProps & { ports: PortDef[]; tool: string }) {
  const inPorts = ports.filter(p => p.dir === 'in');

  // Compute result preview using broadcasting
  const result = useMemo(() => {
    try { return executeMathOp(tool, node.portValues ?? {}); }
    catch { return null; }
  }, [tool, node.portValues]);

  return (
    <>
      <PortRow nodeId={node.id} ports={ports} dir="in" />
      <NodeHeader title={node.title} nodeId={node.id} onTitleChange={onTitleChange} />
      <div className="ng-node-body ng-math-body">
        {inPorts.map(port => {
          const val = node.portValues?.[port.name] ?? 0;
          const dotColor = PORT_COLORS[port.type] || PORT_COLORS.any;
          const isConnected = connectedPorts?.has(port.name);
          return (
            <div key={port.name} className={`ng-port-field${isConnected ? ' ng-port-connected' : ''}`} data-port-ref={port.name}>
              <span className="ng-port-dot" style={{ background: dotColor }} />
              <span className="ng-port-label">{port.label || port.name}</span>
              <MathPortInput nodeId={node.id} portName={port.name} value={val} onChange={onPortValueChange} />
            </div>
          );
        })}
        {result !== null && (
          <div className="ng-math-preview">= {formatResult(result)}</div>
        )}
      </div>
      <PortRow nodeId={node.id} ports={ports} dir="out" />
    </>
  );
}

function UnaryMathNode({ node, connectedPorts, onTitleChange, onPortValueChange, ports, tool }: NodeComponentProps & { ports: PortDef[]; tool: string }) {
  const inPorts = ports.filter(p => p.dir === 'in');

  const result = useMemo(() => {
    try { return executeMathOp(tool, node.portValues ?? {}); }
    catch { return null; }
  }, [tool, node.portValues]);

  return (
    <>
      <PortRow nodeId={node.id} ports={ports} dir="in" />
      <NodeHeader title={node.title} nodeId={node.id} onTitleChange={onTitleChange} />
      <div className="ng-node-body ng-math-body">
        {inPorts.map(port => {
          const val = node.portValues?.[port.name] ?? 0;
          const dotColor = PORT_COLORS[port.type] || PORT_COLORS.any;
          const isConnected = connectedPorts?.has(port.name);
          return (
            <div key={port.name} className={`ng-port-field${isConnected ? ' ng-port-connected' : ''}`} data-port-ref={port.name}>
              <span className="ng-port-dot" style={{ background: dotColor }} />
              <span className="ng-port-label">{port.label || port.name}</span>
              <MathPortInput nodeId={node.id} portName={port.name} value={val} onChange={onPortValueChange} />
            </div>
          );
        })}
        {result !== null && (
          <div className="ng-math-preview">= {formatResult(result)}</div>
        )}
      </div>
      <PortRow nodeId={node.id} ports={ports} dir="out" />
    </>
  );
}

// Shared resolveOutputType for numeric operations (non-Add)
const numericResolve = (inputs: Record<string, string>) => {
  const types = Object.values(inputs);
  if (types.some(t => t === 'matrix')) return { out: 'matrix' };
  if (types.some(t => t === 'color')) return { out: 'color' };
  if (types.some(t => t === 'vector4')) return { out: 'vector4' };
  if (types.some(t => t === 'vector3')) return { out: 'vector3' };
  if (types.some(t => t === 'vector2')) return { out: 'vector2' };
  if (types.some(t => t === 'double')) return { out: 'double' };
  if (types.some(t => t === 'float')) return { out: 'float' };
  if (types.every(t => t === 'int')) return { out: 'int' };
  return { out: 'float' };
};

// --- Add (supports string concat) ---
const ADD_PORTS: PortDef[] = [
  { name: 'a', dir: 'in', type: 'any', label: 'A' },
  { name: 'b', dir: 'in', type: 'any', label: 'B' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_add', {
  label: 'Add', category: 'Math', ports: ADD_PORTS,
  defaultConfig: {
    title: 'Add', tool: 'compute_add', portValues: { a: 0, b: 0 },
    menuTag: { en: 'Math', ko: '덧셈' },
    description: { en: 'Add two values (A + B)', ko: '두 값 더하기 (A + B)' },
  },
  resolveOutputType: (inputs) => {
    if (inputs.a === 'string' || inputs.b === 'string') return { out: 'string' };
    return numericResolve(inputs);
  },
  component: (p: NodeComponentProps) => <BinaryMathNode {...p} ports={ADD_PORTS} tool="compute_add" />,
});

// --- Subtract ---
const SUB_PORTS: PortDef[] = [
  { name: 'a', dir: 'in', type: 'any', label: 'A' },
  { name: 'b', dir: 'in', type: 'any', label: 'B' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_subtract', {
  label: 'Subtract', category: 'Math', ports: SUB_PORTS,
  defaultConfig: {
    title: 'Subtract', tool: 'compute_subtract', portValues: { a: 0, b: 0 },
    menuTag: { en: 'Math', ko: '뺄셈' },
    description: { en: 'Subtract B from A (A - B)', ko: 'A에서 B 빼기 (A - B)' },
  },
  resolveOutputType: numericResolve,
  component: (p: NodeComponentProps) => <BinaryMathNode {...p} ports={SUB_PORTS} tool="compute_subtract" />,
});

// --- Multiply ---
const MUL_PORTS: PortDef[] = [
  { name: 'a', dir: 'in', type: 'any', label: 'A' },
  { name: 'b', dir: 'in', type: 'any', label: 'B' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_multiply', {
  label: 'Multiply', category: 'Math', ports: MUL_PORTS,
  defaultConfig: {
    title: 'Multiply', tool: 'compute_multiply', portValues: { a: 1, b: 1 },
    menuTag: { en: 'Math', ko: '곱셈' },
    description: { en: 'Multiply two values (A × B)', ko: '두 값 곱하기 (A × B)' },
  },
  resolveOutputType: numericResolve,
  component: (p: NodeComponentProps) => <BinaryMathNode {...p} ports={MUL_PORTS} tool="compute_multiply" />,
});

// --- Divide ---
const DIV_PORTS: PortDef[] = [
  { name: 'a', dir: 'in', type: 'any', label: 'A' },
  { name: 'b', dir: 'in', type: 'any', label: 'B' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_divide', {
  label: 'Divide', category: 'Math', ports: DIV_PORTS,
  defaultConfig: {
    title: 'Divide', tool: 'compute_divide', portValues: { a: 1, b: 1 },
    menuTag: { en: 'Math', ko: '나눗셈' },
    description: { en: 'Divide A by B (A ÷ B)', ko: 'A를 B로 나누기 (A ÷ B)' },
  },
  resolveOutputType: numericResolve,
  component: (p: NodeComponentProps) => <BinaryMathNode {...p} ports={DIV_PORTS} tool="compute_divide" />,
});

// --- Power ---
const POW_PORTS: PortDef[] = [
  { name: 'base', dir: 'in', type: 'any', label: 'Base' },
  { name: 'exp', dir: 'in', type: 'any', label: 'Exp' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_power', {
  label: 'Power', category: 'Math', ports: POW_PORTS,
  defaultConfig: {
    title: 'Power', tool: 'compute_power', portValues: { base: 2, exp: 2 },
    menuTag: { en: 'Math', ko: '거듭제곱' },
    description: { en: 'Raise base to exponent (base^exp)', ko: '거듭제곱 (base^exp)' },
  },
  resolveOutputType: numericResolve,
  component: (p: NodeComponentProps) => <BinaryMathNode {...p} ports={POW_PORTS} tool="compute_power" />,
});

// --- Sqrt ---
const SQRT_PORTS: PortDef[] = [
  { name: 'value', dir: 'in', type: 'any', label: 'Value' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_sqrt', {
  label: 'Sqrt', category: 'Math', ports: SQRT_PORTS,
  defaultConfig: {
    title: 'Sqrt', tool: 'compute_sqrt', portValues: { value: 4 },
    menuTag: { en: 'Math', ko: '제곱근' },
    description: { en: 'Square root (√value)', ko: '제곱근 (√value)' },
  },
  resolveOutputType: numericResolve,
  component: (p: NodeComponentProps) => <UnaryMathNode {...p} ports={SQRT_PORTS} tool="compute_sqrt" />,
});

// --- Log ---
const LOG_PORTS: PortDef[] = [
  { name: 'value', dir: 'in', type: 'any', label: 'Value' },
  { name: 'base', dir: 'in', type: 'any', label: 'Base' },
  { name: 'out', dir: 'out', type: 'any' },
];
registerNode('math_log', {
  label: 'Log', category: 'Math', ports: LOG_PORTS,
  defaultConfig: {
    title: 'Log', tool: 'compute_log', portValues: { value: 1, base: 2.718 },
    menuTag: { en: 'Math', ko: '로그' },
    description: { en: 'Logarithm (log_base(value))', ko: '로그 (log_base(value))' },
  },
  resolveOutputType: numericResolve,
  component: (p: NodeComponentProps) => <BinaryMathNode {...p} ports={LOG_PORTS} tool="compute_log" />,
});
