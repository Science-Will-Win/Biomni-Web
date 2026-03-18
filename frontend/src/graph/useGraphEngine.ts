// ============================================
// Graph Engine Hook — state management for node graph
// ============================================

import { useReducer, useCallback, useRef, useMemo } from 'react';
import type { NodeData, ConnectionData, GraphState, SerializedGraphState, NodeStatus } from './types';
import { PortTypes } from './port-types';
import { getNodeDef } from './node-registry';

// Ensure all node types are registered
import './nodes';

type GraphAction =
  | { type: 'ADD_NODE'; payload: NodeData }
  | { type: 'REMOVE_NODE'; payload: string }
  | { type: 'REMOVE_NODES'; payload: string[] }
  | { type: 'UPDATE_NODE'; payload: { id: string } & Partial<NodeData> }
  | { type: 'SET_NODE_STATUS'; payload: { id: string; status: NodeStatus } }
  | { type: 'SET_NODE_TOOL'; payload: { id: string; tool: string } }
  | { type: 'SET_NODE_TITLE'; payload: { id: string; title: string } }
  | { type: 'SET_NODE_DESCRIPTION'; payload: { id: string; description: string } }
  | { type: 'SET_PORT_VALUE'; payload: { nodeId: string; portName: string; value: unknown } }
  | { type: 'ADD_CONNECTION'; payload: ConnectionData }
  | { type: 'REMOVE_CONNECTION'; payload: string }
  | { type: 'SET_VIEWPORT'; payload: { panX: number; panY: number; scale: number } }
  | { type: 'SELECT_NODE'; payload: string | null }
  | { type: 'TOGGLE_SELECT_NODE'; payload: string }
  | { type: 'SET_SELECTED_NODES'; payload: Set<string> }
  | { type: 'SELECT_CONNECTION'; payload: string | null }
  | { type: 'SET_STATE'; payload: SerializedGraphState }
  | { type: 'RELAYOUT_VERTICAL'; payload: { gap: number } }
  | { type: 'CLEAR' };

const initialState: GraphState = {
  nodes: new Map(),
  connections: new Map(),
  panX: 0,
  panY: 0,
  scale: 1,
  selectedNodeId: null,
  selectedNodeIds: new Set(),
  selectedConnectionId: null,
};

function graphReducer(state: GraphState, action: GraphAction): GraphState {
  switch (action.type) {
    case 'ADD_NODE': {
      const nodes = new Map(state.nodes);
      nodes.set(action.payload.id, action.payload);
      return { ...state, nodes };
    }

    case 'REMOVE_NODE': {
      const nodes = new Map(state.nodes);
      nodes.delete(action.payload);
      const connections = new Map(state.connections);
      for (const [id, conn] of connections) {
        if (conn.from === action.payload || conn.to === action.payload) {
          connections.delete(id);
        }
      }
      const selectedNodeIds = new Set(state.selectedNodeIds);
      selectedNodeIds.delete(action.payload);
      return { ...state, nodes, connections, selectedNodeIds,
        selectedNodeId: state.selectedNodeId === action.payload ? null : state.selectedNodeId };
    }

    case 'REMOVE_NODES': {
      const ids = new Set(action.payload);
      const nodes = new Map(state.nodes);
      for (const id of ids) nodes.delete(id);
      const connections = new Map(state.connections);
      for (const [cid, conn] of connections) {
        if (ids.has(conn.from) || ids.has(conn.to)) connections.delete(cid);
      }
      return { ...state, nodes, connections, selectedNodeId: null, selectedNodeIds: new Set() };
    }

    case 'UPDATE_NODE': {
      const nodes = new Map(state.nodes);
      const existing = nodes.get(action.payload.id);
      if (existing) {
        nodes.set(action.payload.id, { ...existing, ...action.payload });
      }
      return { ...state, nodes };
    }

    case 'SET_NODE_STATUS': {
      const node = state.nodes.get(action.payload.id);
      if (!node || node.status === action.payload.status) return state;
      const nodes = new Map(state.nodes);
      nodes.set(action.payload.id, { ...node, status: action.payload.status });
      return { ...state, nodes };
    }

    case 'SET_NODE_TOOL': {
      const node = state.nodes.get(action.payload.id);
      if (!node || node.tool === action.payload.tool) return state;
      const nodes = new Map(state.nodes);
      nodes.set(action.payload.id, { ...node, tool: action.payload.tool });
      return { ...state, nodes };
    }

    case 'SET_NODE_TITLE': {
      const node = state.nodes.get(action.payload.id);
      if (!node || node.title === action.payload.title) return state;
      const nodes = new Map(state.nodes);
      nodes.set(action.payload.id, { ...node, title: action.payload.title });
      return { ...state, nodes };
    }

    case 'SET_NODE_DESCRIPTION': {
      const node = state.nodes.get(action.payload.id);
      if (!node || node.description === action.payload.description) return state;
      const nodes = new Map(state.nodes);
      nodes.set(action.payload.id, { ...node, description: action.payload.description });
      return { ...state, nodes };
    }

    case 'SET_PORT_VALUE': {
      const nodes = new Map(state.nodes);
      const node = nodes.get(action.payload.nodeId);
      if (node) {
        const portValues = { ...node.portValues, [action.payload.portName]: action.payload.value };
        nodes.set(action.payload.nodeId, { ...node, portValues });
      }
      return { ...state, nodes };
    }

    case 'ADD_CONNECTION': {
      const conn = action.payload;
      // Duplicate check
      for (const existing of state.connections.values()) {
        if (existing.from === conn.from && existing.fromPort === conn.fromPort &&
            existing.to === conn.to && existing.toPort === conn.toPort &&
            existing.type === conn.type) {
          return state;
        }
      }
      // Rule 1: ref connection requires target node allowRef
      if (conn.type === 'ref') {
        const toNode = state.nodes.get(conn.to);
        if (toNode) {
          const toDef = getNodeDef(toNode.type);
          if (!toDef?.allowRef) return state;
        }
        // Rule 3: ref maxAttachments limit (5)
        let refCount = 0;
        for (const existing of state.connections.values()) {
          if (existing.to === conn.to && existing.toPort === conn.toPort && existing.type === 'ref') {
            refCount++;
          }
        }
        if (refCount >= 5) return state;
        // Rule 4: forward ref 차단 — from(과거)의 depth < to(미래)의 depth
        const fromNode = state.nodes.get(conn.from);
        if (fromNode?.stepNum && toNode?.stepNum) {
          if (parseFloat(fromNode.stepNum) >= parseFloat(toNode.stepNum)) return state;
        }
      }
      // Type compatibility check for flow connections
      const connections = new Map(state.connections);
      if (conn.type === 'flow') {
        const fromNode = state.nodes.get(conn.from);
        const toNode = state.nodes.get(conn.to);
        if (fromNode && toNode) {
          const fromDef = getNodeDef(fromNode.type);
          const toDef = getNodeDef(toNode.type);
          const fromPortDef = fromDef?.ports.find(p => p.name === conn.fromPort);
          const toPortDef = toDef?.ports.find(p => p.name === conn.toPort);
          if (fromPortDef && toPortDef && !PortTypes.isCompatible(fromPortDef.type, toPortDef.type)) {
            return state;
          }
        }
        // Rule 2: single flow per input port (auto-replace existing)
        for (const [existingId, existing] of connections) {
          if (existing.to === conn.to && existing.toPort === conn.toPort && existing.type === 'flow') {
            connections.delete(existingId);
            break;
          }
        }
      }
      connections.set(conn.id, conn);
      return { ...state, connections };
    }

    case 'REMOVE_CONNECTION': {
      const connections = new Map(state.connections);
      connections.delete(action.payload);
      return { ...state, connections };
    }

    case 'SET_VIEWPORT':
      return { ...state, ...action.payload };

    case 'SELECT_NODE': {
      const selectedNodeIds = new Set<string>();
      if (action.payload) selectedNodeIds.add(action.payload);
      return { ...state, selectedNodeId: action.payload, selectedNodeIds };
    }

    case 'TOGGLE_SELECT_NODE': {
      const selectedNodeIds = new Set(state.selectedNodeIds);
      if (selectedNodeIds.has(action.payload)) {
        selectedNodeIds.delete(action.payload);
      } else {
        selectedNodeIds.add(action.payload);
      }
      const selectedNodeId = selectedNodeIds.size === 1 ? [...selectedNodeIds][0] : (selectedNodeIds.size === 0 ? null : state.selectedNodeId);
      return { ...state, selectedNodeId, selectedNodeIds, selectedConnectionId: null };
    }

    case 'SET_SELECTED_NODES': {
      const ids = action.payload;
      const selectedNodeId = ids.size === 1 ? [...ids][0] : (ids.size === 0 ? null : state.selectedNodeId);
      return { ...state, selectedNodeId, selectedNodeIds: ids, selectedConnectionId: null };
    }

    case 'SELECT_CONNECTION':
      return { ...state, selectedConnectionId: action.payload };

    case 'SET_STATE': {
      const nodes = new Map<string, NodeData>();
      for (const n of action.payload.nodes) nodes.set(n.id, n);
      const connections = new Map<string, ConnectionData>();
      for (const c of action.payload.connections) connections.set(c.id, c);
      return {
        ...state,
        nodes,
        connections,
        panX: action.payload.panX ?? state.panX,
        panY: action.payload.panY ?? state.panY,
        scale: action.payload.scale ?? state.scale,
        selectedNodeId: null,
        selectedNodeIds: new Set(),
        selectedConnectionId: null,
      };
    }

    case 'RELAYOUT_VERTICAL': {
      const gap = action.payload.gap;
      const nodes = new Map(state.nodes);
      // Build adjacency for topological sort
      const childMap = new Map<string, string[]>();
      const parentMap = new Map<string, string[]>();
      for (const n of nodes.values()) { childMap.set(n.id, []); parentMap.set(n.id, []); }
      for (const conn of state.connections.values()) {
        if (conn.type === 'ref') continue;
        childMap.get(conn.from)?.push(conn.to);
        parentMap.get(conn.to)?.push(conn.from);
      }
      // Kahn's topological sort
      const inDeg = new Map<string, number>();
      for (const [id, p] of parentMap) inDeg.set(id, p.length);
      const queue: string[] = [];
      for (const [id, d] of inDeg) { if (d === 0) queue.push(id); }
      const sorted: string[] = [];
      while (queue.length > 0) {
        const id = queue.shift()!;
        sorted.push(id);
        for (const c of (childMap.get(id) || [])) {
          inDeg.set(c, inDeg.get(c)! - 1);
          if (inDeg.get(c) === 0) queue.push(c);
        }
      }
      // Assign Y positions based on topological order, using actual node heights
      // for edge-to-edge equal spacing
      let currentY = 40;
      for (const id of sorted) {
        const n = nodes.get(id);
        if (n) {
          if (n.userMoved) {
            // 수동 이동 노드는 위치 유지, currentY만 갱신
            currentY = Math.max(currentY, n.y + (n.height || 80) + gap);
          } else {
            nodes.set(id, { ...n, x: 0, y: currentY });
            currentY += (n.height || 80) + gap;
          }
        }
      }
      return { ...state, nodes };
    }

    case 'CLEAR':
      return { ...initialState, nodes: new Map(), connections: new Map(), selectedNodeIds: new Set() };

    default:
      return state;
  }
}

const MAX_UNDO = 50;
let nextConnId = 1;

function serializeState(s: GraphState): SerializedGraphState {
  return {
    nodes: Array.from(s.nodes.values()).map(n => ({ ...n })),
    connections: Array.from(s.connections.values()).map(c => ({ ...c })),
  };
}

export function useGraphEngine() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
  const undoStack = useRef<SerializedGraphState[]>([]);
  const redoStack = useRef<SerializedGraphState[]>([]);

  const addNode = useCallback((node: NodeData) => {
    dispatch({ type: 'ADD_NODE', payload: node });
  }, []);

  const updateNode = useCallback((id: string, updates: Partial<NodeData>) => {
    dispatch({ type: 'UPDATE_NODE', payload: { id, ...updates } });
  }, []);

  const removeNode = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_NODE', payload: id });
  }, []);

  const removeNodes = useCallback((ids: string[]) => {
    dispatch({ type: 'REMOVE_NODES', payload: ids });
  }, []);

  const setNodeStatus = useCallback((id: string, status: NodeStatus) => {
    dispatch({ type: 'SET_NODE_STATUS', payload: { id, status } });
  }, []);

  const setNodeTool = useCallback((id: string, tool: string) => {
    dispatch({ type: 'SET_NODE_TOOL', payload: { id, tool } });
  }, []);

  const setNodeTitle = useCallback((id: string, title: string) => {
    dispatch({ type: 'SET_NODE_TITLE', payload: { id, title } });
  }, []);

  const setNodeDescription = useCallback((id: string, description: string) => {
    dispatch({ type: 'SET_NODE_DESCRIPTION', payload: { id, description } });
  }, []);

  const setPortValue = useCallback((nodeId: string, portName: string, value: unknown) => {
    dispatch({ type: 'SET_PORT_VALUE', payload: { nodeId, portName, value } });
  }, []);

  const addConnection = useCallback((
    from: string, fromPort: string, to: string, toPort: string, type: 'flow' | 'ref' = 'flow'
  ) => {
    const id = `conn-${nextConnId++}`;
    dispatch({ type: 'ADD_CONNECTION', payload: { id, from, fromPort, to, toPort, type } });
    return id;
  }, []);

  const removeConnection = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_CONNECTION', payload: id });
  }, []);

  const setViewport = useCallback((panX: number, panY: number, scale: number) => {
    dispatch({ type: 'SET_VIEWPORT', payload: { panX, panY, scale } });
  }, []);

  const selectNode = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_NODE', payload: id });
    dispatch({ type: 'SELECT_CONNECTION', payload: null });
  }, []);

  const toggleSelectNode = useCallback((id: string) => {
    dispatch({ type: 'TOGGLE_SELECT_NODE', payload: id });
  }, []);

  const setSelectedNodes = useCallback((ids: Set<string>) => {
    dispatch({ type: 'SET_SELECTED_NODES', payload: ids });
  }, []);

  const selectConnection = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_CONNECTION', payload: id });
    dispatch({ type: 'SELECT_NODE', payload: null });
  }, []);

  const relayoutVertical = useCallback((gap = 50) => {
    dispatch({ type: 'RELAYOUT_VERTICAL', payload: { gap } });
  }, []);

  const clear = useCallback(() => {
    nextConnId = 1;
    dispatch({ type: 'CLEAR' });
  }, []);

  const getSerializedState = useCallback((): SerializedGraphState => ({
    nodes: Array.from(state.nodes.values()),
    connections: Array.from(state.connections.values()),
    panX: state.panX,
    panY: state.panY,
    scale: state.scale,
  }), [state]);

  const setState = useCallback((s: SerializedGraphState) => {
    dispatch({ type: 'SET_STATE', payload: s });
  }, []);

  // Undo/Redo
  const pushUndo = useCallback(() => {
    undoStack.current.push(serializeState(state));
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
  }, [state]);

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    redoStack.current.push(serializeState(state));
    const snapshot = undoStack.current.pop()!;
    dispatch({ type: 'SET_STATE', payload: snapshot });
  }, [state]);

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    undoStack.current.push(serializeState(state));
    const snapshot = redoStack.current.pop()!;
    dispatch({ type: 'SET_STATE', payload: snapshot });
  }, [state]);

  return useMemo(() => ({
    state,
    addNode,
    updateNode,
    removeNode,
    removeNodes,
    setNodeStatus,
    setNodeTool,
    setNodeTitle,
    setNodeDescription,
    setPortValue,
    addConnection,
    removeConnection,
    setViewport,
    selectNode,
    toggleSelectNode,
    setSelectedNodes,
    selectConnection,
    relayoutVertical,
    clear,
    getSerializedState,
    setState,
    pushUndo,
    undo,
    redo,
  }), [
    state, addNode, updateNode, removeNode, removeNodes,
    setNodeStatus, setNodeTool, setNodeTitle, setNodeDescription, setPortValue,
    addConnection, removeConnection, setViewport, selectNode,
    toggleSelectNode, setSelectedNodes, selectConnection,
    relayoutVertical, clear, getSerializedState, setState,
    pushUndo, undo, redo,
  ]);
}
