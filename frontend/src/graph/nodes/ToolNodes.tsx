// ============================================
// Biomni Tool Nodes — dynamically registered from backend API
// ============================================

import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { NodeHeader } from '../components/NodeHeader';
import { PortRow } from '../components/PortRow';
import { ProgressBar } from '../components/ProgressBar';
import { PORT_COLORS } from '../port-types';
import { useState } from 'react';
import type { PortDef, PortType } from '../types';
import {
  fetchBiomniTools,
  pythonTypeToPortType,
  getModuleLabel,
  type BiomniToolDef,
  type BiomniToolParam,
} from '../tool-service';

// ── Shared Tool Port Input ──

function ToolPortInput({ nodeId, portName, value, portType, placeholder, onChange }: {
  nodeId: string; portName: string; value: unknown; portType: string;
  placeholder?: string;
  onChange?: (nodeId: string, portName: string, value: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (portType === 'boolean') {
    const checked = Boolean(value);
    return (
      <input
        className="ng-port-default ng-interactive"
        type="checkbox"
        checked={checked}
        onChange={() => onChange?.(nodeId, portName, !checked)}
        onMouseDown={e => e.stopPropagation()}
      />
    );
  }

  // data/any types — display-only placeholder (must be connected)
  if (portType === 'data' || portType === 'any') {
    return (
      <span className="ng-port-default ng-port-placeholder">
        {value != null ? String(value) : (placeholder || '—')}
      </span>
    );
  }

  // string or int — editable text input
  const isInt = portType === 'int';
  const displayVal = value != null ? String(value) : '';

  return (
    <input
      className="ng-port-default ng-interactive"
      type="text"
      inputMode={isInt ? 'numeric' : 'text'}
      placeholder={placeholder || portName}
      value={editing ? draft : displayVal}
      onFocus={e => { setEditing(true); setDraft(e.target.value); }}
      onChange={e => {
        const raw = e.target.value;
        if (isInt && raw !== '' && raw !== '-' && !/^-?\d*$/.test(raw)) return;
        setDraft(raw);
        if (isInt) {
          const num = raw === '' || raw === '-' ? 0 : parseInt(raw);
          onChange?.(nodeId, portName, isNaN(num) ? 0 : num);
        } else {
          onChange?.(nodeId, portName, raw);
        }
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      onMouseDown={e => e.stopPropagation()}
    />
  );
}

// ── Biomni Tool Node Component ──

// Store port definitions per tool name for runtime lookup
const toolPortsMap = new Map<string, PortDef[]>();

function BiomniToolNodeComponent({ node, connectedPorts, onTitleChange, onPortValueChange }: NodeComponentProps) {
  const ports = toolPortsMap.get(node.tool || node.type) || [];
  const inPorts = ports.filter(p => p.dir === 'in' && p.name !== 'in');

  return (
    <>
      <PortRow nodeId={node.id} ports={ports} dir="in" />
      <NodeHeader title={node.title} nodeId={node.id} onTitleChange={onTitleChange} stepNum={node.stepNum} />
      <div className="ng-node-body ng-tool-params-body">
        {inPorts.map(port => {
          const val = node.portValues?.[port.name];
          const dotColor = PORT_COLORS[port.type] || PORT_COLORS.any;
          const isConnected = connectedPorts?.has(port.name);
          return (
            <div key={port.name} className={`ng-port-field${isConnected ? ' ng-port-connected' : ''}`} data-port-ref={port.name}>
              <span className="ng-port-dot" style={{ background: dotColor }} />
              <span className={`ng-port-label${port.required ? ' ng-port-required' : ''}`}>
                {port.label || port.name}
              </span>
              <ToolPortInput
                nodeId={node.id}
                portName={port.name}
                value={val}
                portType={port.type}
                placeholder={port.label || port.name}
                onChange={onPortValueChange}
              />
            </div>
          );
        })}
      </div>
      <ProgressBar />
      <PortRow nodeId={node.id} ports={ports} dir="out" />
    </>
  );
}

// ── Dynamic Registration ──

function buildPorts(toolDef: BiomniToolDef): PortDef[] {
  const ports: PortDef[] = [
    { name: 'in', dir: 'in', type: 'any' },
  ];

  for (const param of toolDef.required_parameters || []) {
    ports.push({
      name: param.name,
      dir: 'in',
      type: pythonTypeToPortType(param.type) as PortType,
      label: param.name,
      required: true,
      description: param.description,
    });
  }

  for (const param of toolDef.optional_parameters || []) {
    ports.push({
      name: param.name,
      dir: 'in',
      type: pythonTypeToPortType(param.type) as PortType,
      label: param.name,
      description: param.description,
    });
  }

  ports.push({ name: 'out', dir: 'out', type: 'any' });
  return ports;
}

function buildDefaultPortValues(toolDef: BiomniToolDef): Record<string, unknown> {
  const portValues: Record<string, unknown> = {};
  for (const param of toolDef.optional_parameters || []) {
    if (param.default != null) {
      portValues[param.name] = param.default;
    }
  }
  return portValues;
}

export async function registerBiomniTools(): Promise<number> {
  const modules = await fetchBiomniTools();
  let count = 0;

  for (const [module, tools] of Object.entries(modules)) {
    const moduleLabel = getModuleLabel(module);

    for (const toolDef of tools) {
      const nodeId = `tool_${toolDef.name}`;
      const ports = buildPorts(toolDef);
      const portValues = buildDefaultPortValues(toolDef);

      // Store ports for runtime component lookup
      toolPortsMap.set(nodeId, ports);
      toolPortsMap.set(toolDef.name, ports);

      registerNode(nodeId, {
        label: toolDef.name,
        category: 'Tool',
        subcategory: moduleLabel.en,
        allowRef: true,
        minWidth: 280,
        ports,
        defaultConfig: {
          title: toolDef.name,
          tool: toolDef.name,
          status: 'pending',
          portValues,
          menuTag: moduleLabel,
          description: { en: toolDef.description, ko: toolDef.description },
        },
        component: BiomniToolNodeComponent,
      });
      count++;
    }
  }

  console.log(`[ToolNodes] Registered ${count} Biomni tools`);
  return count;
}
