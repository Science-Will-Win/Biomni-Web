// ============================================
// Graph Type Definitions
// ============================================

export type PortDir = 'in' | 'out';
export type PortType =
  | 'any' | 'float' | 'int' | 'double' | 'string' | 'boolean'
  | 'matrix' | 'vector2' | 'vector3' | 'vector4' | 'color'
  | 'data' | 'table' | 'image';

export type NodeStatus = 'pending' | 'running' | 'completed' | 'error' | 'stopped';
export type ConnectionType = 'flow' | 'ref';

export interface PortDef {
  name: string;
  dir: PortDir;
  type: PortType;
  label?: string;
  required?: boolean;
  description?: string;
}

export interface I18nField {
  [lang: string]: string;
}

export interface NodeData {
  id: string;
  type: string;
  title: string;
  tool?: string;
  description?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  status: NodeStatus;
  stepNum?: string;
  portValues?: Record<string, unknown>;
  resultText?: string;
  userResized?: boolean;
  userMoved?: boolean;
}

export interface ConnectionData {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  type: ConnectionType;
}

export interface GraphState {
  nodes: Map<string, NodeData>;
  connections: Map<string, ConnectionData>;
  panX: number;
  panY: number;
  scale: number;
  selectedNodeId: string | null;
  selectedNodeIds: Set<string>;
  selectedConnectionId: string | null;
}

export interface SerializedGraphState {
  nodes: NodeData[];
  connections: ConnectionData[];
  panX?: number;
  panY?: number;
  scale?: number;
}

export interface PlanStep {
  id?: string;
  name?: string;
  tool?: string;
  description?: string;
}

export interface PlanData {
  goal?: string;
  userMessage?: string;
  steps: PlanStep[];
}
