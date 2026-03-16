// ============================================
// Node Type Registry (React version)
// ============================================

import type { NodeData, PortDef, I18nField } from './types';

export interface NodeComponentProps {
  node: NodeData;
  connectedPorts?: Set<string>;
  onTitleChange?: (nodeId: string, newTitle: string) => void;
  onPortValueChange?: (nodeId: string, portName: string, value: unknown) => void;
}

export type NodeComponent = React.ComponentType<NodeComponentProps>;

export interface NodeDefinition {
  label: string;
  category: string;
  ports: PortDef[];
  defaultConfig: {
    title: string;
    tool?: string;
    status?: string;
    stepNum?: string;
    portValues?: Record<string, unknown>;
    menuTag?: I18nField;
    description?: I18nField;
  };
  component: NodeComponent;
  allowRef?: boolean;
  dataOnly?: boolean;
  result?: boolean;
  subcategory?: string;
  minWidth?: number;
  resolveOutputType?: (connectedInputTypes: Record<string, string>) => Record<string, string>;
}

const _types: Map<string, NodeDefinition> = new Map();

export function registerNode(type: string, definition: NodeDefinition) {
  if (!type || !definition) return;
  definition.category = definition.category || 'General';
  definition.label = definition.label || type;
  definition.ports = definition.ports || [
    { name: 'in', dir: 'in', type: 'any' },
    { name: 'out', dir: 'out', type: 'any' },
  ];
  _types.set(type, definition);
}

export function getNodeDef(type: string): NodeDefinition | null {
  return _types.get(type) || _types.get('step') || null;
}

export function getAllNodeTypes(): string[] {
  return Array.from(_types.keys());
}

export function getByCategory(): Record<string, Array<{ type: string; label: string; definition: NodeDefinition }>> {
  const result: Record<string, Array<{ type: string; label: string; definition: NodeDefinition }>> = {};
  for (const [type, def] of _types.entries()) {
    const cat = def.category || 'General';
    if (!result[cat]) result[cat] = [];
    result[cat].push({ type, label: def.label || type, definition: def });
  }
  return result;
}
