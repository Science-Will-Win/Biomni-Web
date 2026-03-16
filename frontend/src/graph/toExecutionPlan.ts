// ============================================
// Graph → Execution Plan conversion
// ============================================

import type { NodeData, ConnectionData } from './types';
import { getNodeDef } from './node-registry';

export interface ExecutionStep {
  id: string;
  name: string;
  tool: string;
  description: string;
  depends_on: string[];
  // Semantic ref fields (ref connections, categorized by source node type)
  refTools?: { name: string; params?: Record<string, unknown> }[];
  refDataLake?: { name: string; description: string }[];
  refLibraries?: { name: string; description: string }[];
  refSteps?: { stepId: string; name: string }[];
  references?: { nodeId: string; title: string; nodeType: string; portValues?: Record<string, unknown> }[];
  // Semantic flow fields (flow connections from dataOnly nodes)
  flowLibraries?: { name: string; description: string }[];
  flowData?: { name: string; description: string }[];
  inputs?: Record<string, { nodeType: string; title: string; portValues?: Record<string, unknown> }>;
  portValues?: Record<string, unknown>;
  toolParams?: Record<string, unknown>;
}

export interface ExecutionPlan {
  goal: string;
  steps: ExecutionStep[];
}

function buildGraphMaps(nodes: Map<string, NodeData>, connections: Map<string, ConnectionData>) {
  const connectedIds = new Set<string>();
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const node of nodes.values()) {
    children.set(node.id, []);
    parents.set(node.id, []);
  }
  for (const conn of connections.values()) {
    if (conn.type === 'ref') continue;
    children.get(conn.from)?.push(conn.to);
    parents.get(conn.to)?.push(conn.from);
    connectedIds.add(conn.from);
    connectedIds.add(conn.to);
  }
  return { children, parents, connectedIds };
}

export function toExecutionPlan(
  nodes: Map<string, NodeData>,
  connections: Map<string, ConnectionData>,
  options: { excludeResult?: boolean } = {},
): ExecutionPlan | null {
  if (nodes.size === 0) return null;

  const { excludeResult = false } = options;
  const { children, parents, connectedIds } = buildGraphMaps(nodes, connections);

  // Detect Tool Nodes connected to Step Nodes via flow
  // Tool Node → Step means "use this tool for this step"
  const toolNodeParentOf = new Map<string, string>(); // toolNodeId → stepNodeId
  const stepToolAssignment = new Map<string, { tool: string; portValues?: Record<string, unknown> }>(); // stepNodeId → tool info
  for (const conn of connections.values()) {
    if (conn.type !== 'flow') continue;
    const fromNode = nodes.get(conn.from);
    const toNode = nodes.get(conn.to);
    if (!fromNode || !toNode) continue;
    const fromDef = getNodeDef(fromNode.type);
    const toDef = getNodeDef(toNode.type);
    if (fromDef?.category === 'Tool' && !fromDef.dataOnly && toDef && !toDef.dataOnly) {
      toolNodeParentOf.set(fromNode.id, toNode.id);
      const toolName = fromNode.tool || fromDef.defaultConfig?.tool || '';
      if (toolName) {
        stepToolAssignment.set(toNode.id, { tool: toolName, portValues: fromNode.portValues });
      }
    }
  }

  // Filter to candidate step nodes (connected, not analysis, not dataOnly, not Tool Nodes used as parents)
  const candidateIds = new Set<string>();
  for (const node of nodes.values()) {
    if (!connectedIds.has(node.id)) continue;
    if (node.id === 'analysis-node') continue;
    if (toolNodeParentOf.has(node.id)) continue; // Exclude Tool Nodes acting as tool providers
    const def = getNodeDef(node.type);
    if (def?.dataOnly) continue;
    if (def?.result) continue; // result 노드 (observe, save, visualize, table) 제외
    if (excludeResult && node.type === 'analyze') continue;
    candidateIds.add(node.id);
  }

  // Topological sort (Kahn's algorithm)
  const filteredChildren = new Map<string, string[]>();
  const filteredParents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of candidateIds) {
    filteredChildren.set(id, (children.get(id) || []).filter(c => candidateIds.has(c)));
    filteredParents.set(id, (parents.get(id) || []).filter(p => candidateIds.has(p)));
    inDegree.set(id, filteredParents.get(id)!.length);
  }

  const depthCache = new Map<string, number>();
  function maxDescendantDepth(nodeId: string): number {
    if (depthCache.has(nodeId)) return depthCache.get(nodeId)!;
    const kids = filteredChildren.get(nodeId) || [];
    if (kids.length === 0) { depthCache.set(nodeId, 0); return 0; }
    const d = 1 + Math.max(...kids.map(c => maxDescendantDepth(c)));
    depthCache.set(nodeId, d);
    return d;
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    if (queue.length > 1) {
      queue.sort((a, b) => maxDescendantDepth(b) - maxDescendantDepth(a));
    }
    const id = queue.shift()!;
    sorted.push(id);
    for (const childId of (filteredChildren.get(id) || [])) {
      inDegree.set(childId, inDegree.get(childId)! - 1);
      if (inDegree.get(childId) === 0) queue.push(childId);
    }
  }

  if (sorted.length < candidateIds.size) {
    console.warn(`Cycle detected in graph — ${candidateIds.size - sorted.length} node(s) excluded from execution plan`);
  }

  // Assign numbering
  const numbering = new Map<string, string>();
  let mainCounter = 0;
  for (const nodeId of sorted) {
    const parentIds = filteredParents.get(nodeId) || [];
    if (parentIds.length === 0) {
      mainCounter++;
      numbering.set(nodeId, `${mainCounter}`);
    } else if (parentIds.length === 1) {
      const parentId = parentIds[0];
      const siblings = filteredChildren.get(parentId) || [];
      if (siblings.length > 1) {
        const siblingIndex = siblings.indexOf(nodeId) + 1;
        const parentNum = numbering.get(parentId) || `${mainCounter}`;
        numbering.set(nodeId, `${parentNum}-${siblingIndex}`);
      } else {
        mainCounter++;
        numbering.set(nodeId, `${mainCounter}`);
      }
    } else {
      mainCounter++;
      numbering.set(nodeId, `${mainCounter}`);
    }
  }

  // Build steps with semantic connection classification
  const steps: ExecutionStep[] = sorted.map(nodeId => {
    const node = nodes.get(nodeId)!;
    const refs: NonNullable<ExecutionStep['references']> = [];
    const refTools: { name: string; params?: Record<string, unknown> }[] = [];
    const refDataLake: { name: string; description: string }[] = [];
    const refLibraries: { name: string; description: string }[] = [];
    const refSteps: { stepId: string; name: string }[] = [];
    const flowLibraries: { name: string; description: string }[] = [];
    const flowData: { name: string; description: string }[] = [];
    const inputs: Record<string, { nodeType: string; title: string; portValues?: Record<string, unknown> }> = {};

    for (const conn of connections.values()) {
      // --- ref connections: categorize by source node type ---
      if (conn.type === 'ref' && conn.to === nodeId) {
        const refNode = nodes.get(conn.from);
        if (!refNode) continue;
        const refDef = getNodeDef(refNode.type);
        if (refDef?.category === 'Tool') {
          const toolName = refNode.tool || refDef.defaultConfig?.tool || refNode.title;
          refTools.push({ name: toolName, params: refNode.portValues });
        } else if (refNode.type === 'data' || refNode.type.startsWith('dl_')) {
          const desc = refNode.portValues?.out;
          const descStr = typeof desc === 'object' && desc
            ? (desc as { fileName?: string }).fileName || ''
            : String(desc || '');
          refDataLake.push({ name: refNode.title, description: descStr });
        } else if (refNode.type === 'library' || refNode.type.startsWith('lib_')) {
          refLibraries.push({ name: refNode.title, description: String(refNode.portValues?.out || '') });
        } else if (refNode.type === 'step' || refNode.type === 'composite') {
          const refStepNum = numbering.get(refNode.id) || '';
          refSteps.push({ stepId: refStepNum, name: refNode.title });
        } else {
          refs.push({ nodeId: refNode.id, title: refNode.title, nodeType: refNode.type, portValues: refNode.portValues });
        }
      }
      // --- flow connections: categorize dataOnly source nodes ---
      if (conn.type === 'flow' && conn.to === nodeId) {
        const parentNode = nodes.get(conn.from);
        if (!parentNode) continue;
        const parentDef = getNodeDef(parentNode.type);
        if (!parentDef?.dataOnly) continue;
        if (parentNode.type === 'library' || parentNode.type.startsWith('lib_')) {
          flowLibraries.push({ name: parentNode.title, description: String(parentNode.portValues?.out || '') });
        } else if (parentNode.type === 'data' || parentNode.type.startsWith('dl_')) {
          const desc = parentNode.portValues?.out;
          const descStr = typeof desc === 'object' && desc
            ? (desc as { fileName?: string }).fileName || ''
            : String(desc || '');
          flowData.push({ name: parentNode.title, description: descStr });
        } else {
          inputs[conn.toPort || 'in'] = { nodeType: parentNode.type, title: parentNode.title, portValues: parentNode.portValues };
        }
      }
    }

    // Tool Node connection overrides node's own tool
    const assigned = stepToolAssignment.get(nodeId);
    const toolName = assigned?.tool || node.tool || '';
    const toolParams = assigned?.portValues;
    const step: ExecutionStep = {
      id: numbering.get(nodeId) || '',
      name: node.title,
      tool: toolName,
      description: node.description || '',
      depends_on: (filteredParents.get(nodeId) || []).map(pid => numbering.get(pid) || ''),
    };
    if (toolParams && Object.keys(toolParams).length > 0) step.toolParams = toolParams;
    if (refTools.length > 0) step.refTools = refTools;
    if (refDataLake.length > 0) step.refDataLake = refDataLake;
    if (refLibraries.length > 0) step.refLibraries = refLibraries;
    if (refSteps.length > 0) step.refSteps = refSteps;
    if (refs.length > 0) step.references = refs;
    if (flowLibraries.length > 0) step.flowLibraries = flowLibraries;
    if (flowData.length > 0) step.flowData = flowData;
    if (Object.keys(inputs).length > 0) step.inputs = inputs;
    if (node.portValues && Object.keys(node.portValues).length > 0) step.portValues = node.portValues;
    return step;
  });

  // Extract goal from prompt input node (string type, typically id 'prompt-input')
  let goal = '';
  for (const node of nodes.values()) {
    if (node.type === 'string' && node.portValues?.out) {
      goal = String(node.portValues.out);
      break;
    }
  }

  return { goal, steps };
}

export function getExecutionPlanHash(nodes: Map<string, NodeData>, connections: Map<string, ConnectionData>): string | null {
  const plan = toExecutionPlan(nodes, connections, { excludeResult: true });
  if (!plan || plan.steps.length === 0) return null;
  return plan.steps.map(s => `${s.id}:${s.tool}:${s.name}`).join('|');
}

/**
 * Check if the graph has a valid prompt→analysis flow path.
 * Required for "Start from Graph" — at least one flow connection path
 * must exist from a prompt node (type: 'string') to the analysis node (id: 'analysis-node').
 */
export function canStartFromGraph(
  nodes: Map<string, NodeData>,
  connections: Map<string, ConnectionData>,
): boolean {
  let promptId: string | null = null;
  let analysisId: string | null = null;
  for (const node of nodes.values()) {
    if (node.type === 'string') promptId = node.id;
    if (node.id === 'analysis-node') analysisId = node.id;
  }
  if (!promptId || !analysisId) return false;

  // BFS from prompt to analysis via flow connections only
  const adj = new Map<string, string[]>();
  for (const conn of connections.values()) {
    if (conn.type !== 'flow') continue;
    if (!adj.has(conn.from)) adj.set(conn.from, []);
    adj.get(conn.from)!.push(conn.to);
  }
  const visited = new Set<string>();
  const queue = [promptId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === analysisId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const next of (adj.get(cur) || [])) queue.push(next);
  }
  return false;
}
