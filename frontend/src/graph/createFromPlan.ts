// ============================================
// Plan → Graph Conversion
// ============================================

import type { PlanData, NodeData, ConnectionData } from './types';

interface GraphBuildResult {
  nodes: NodeData[];
  connections: ConnectionData[];
}

export function createFromPlan(planData: PlanData): GraphBuildResult {
  const steps = planData.steps || [];
  const nodes: NodeData[] = [];
  const connections: ConnectionData[] = [];

  if (steps.length === 0) return { nodes, connections };

  const nodeWidth = 320;
  const edgeGap = 50;
  // Type-specific estimated heights for edge-to-edge equal spacing
  const stepHeight = 80;      // header + description
  const analysisHeight = 60;  // compact
  const startX = 0;
  let currentY = 40;
  let connId = 1;

  // Prompt input node — dynamic height based on text content
  const promptText = planData.userMessage || planData.goal || '';
  const charsPerLine = Math.floor((nodeWidth - 24) / 7.5); // ~7.5px per char at 11px monospace
  const textLineCount = promptText.split('\n').reduce((acc: number, line: string) =>
    acc + Math.max(1, Math.ceil(Math.max(1, line.length) / charsPerLine)), 0);
  const promptHeight = Math.max(90, 54 + textLineCount * 16); // header(~54px) + lines * lineHeight(16px)
  const promptNodeId = 'prompt-input';
  nodes.push({
    id: promptNodeId,
    type: 'string',
    title: 'Prompt',
    x: startX,
    y: currentY,
    width: nodeWidth,
    height: promptHeight,
    status: 'completed',
    portValues: { out: promptText },
  });
  currentY += promptHeight + edgeGap;

  // Step nodes
  const stepNodeIds: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const id = `step-${i + 1}`;
    nodes.push({
      id,
      type: 'step',
      title: step.name || `Step ${i + 1}`,
      tool: step.tool || '',
      description: step.description || '',
      x: startX,
      y: currentY,
      width: nodeWidth,
      height: stepHeight,
      stepNum: step.id || `${i + 1}`,
      status: 'pending',
    });
    stepNodeIds.push(id);
    currentY += stepHeight + edgeGap;
  }

  // Analysis node
  const analysisNodeId = 'analysis-node';
  nodes.push({
    id: analysisNodeId,
    type: 'analyze',
    title: 'Analysis',
    tool: 'analyze_plan',
    x: startX,
    y: currentY,
    width: nodeWidth,
    height: analysisHeight,
    status: 'pending',
  });

  // Connect: Prompt → Step1
  if (stepNodeIds.length > 0) {
    connections.push({
      id: `conn-${connId++}`,
      from: promptNodeId,
      fromPort: 'out',
      to: stepNodeIds[0],
      toPort: 'in',
      type: 'flow',
    });
  }

  // Connect: Step[i] → Step[i+1]
  for (let i = 0; i < stepNodeIds.length - 1; i++) {
    connections.push({
      id: `conn-${connId++}`,
      from: stepNodeIds[i],
      fromPort: 'out',
      to: stepNodeIds[i + 1],
      toPort: 'in',
      type: 'flow',
    });
  }

  // Connect: Last Step → Analysis
  if (stepNodeIds.length > 0) {
    connections.push({
      id: `conn-${connId++}`,
      from: stepNodeIds[stepNodeIds.length - 1],
      fromPort: 'out',
      to: analysisNodeId,
      toPort: 'in',
      type: 'flow',
    });
  } else {
    connections.push({
      id: `conn-${connId++}`,
      from: promptNodeId,
      fromPort: 'out',
      to: analysisNodeId,
      toPort: 'in',
      type: 'flow',
    });
  }

  return { nodes, connections };
}

/**
 * Create a minimal empty graph scaffold (Prompt + Analysis node).
 * User can then add step nodes via the canvas CreateNodeMenu.
 */
export function createEmptyGraph(promptText: string = ''): GraphBuildResult {
  const nodeWidth = 320;
  const nodes: NodeData[] = [];
  const connections: ConnectionData[] = [];
  let currentY = 40;

  // Prompt Input node — dynamic height based on text content
  const charsPerLine = Math.floor((nodeWidth - 24) / 7.5);
  const textLineCount = promptText
    ? promptText.split('\n').reduce((acc: number, line: string) =>
        acc + Math.max(1, Math.ceil(Math.max(1, line.length) / charsPerLine)), 0)
    : 0;
  const promptHeight = Math.max(90, 54 + textLineCount * 16);

  nodes.push({
    id: 'prompt-input',
    type: 'string',
    title: 'Prompt',
    x: 0,
    y: currentY,
    width: nodeWidth,
    height: promptHeight,
    status: 'pending',
    portValues: { out: promptText },
  });
  currentY += promptHeight + 50;

  // Analysis node
  nodes.push({
    id: 'analysis-node',
    type: 'analyze',
    title: 'Analysis',
    tool: 'analyze_plan',
    x: 0,
    y: currentY,
    width: nodeWidth,
    height: 60,
    status: 'pending',
  });

  // Connect Prompt → Analysis
  connections.push({
    id: 'conn-1',
    from: 'prompt-input',
    fromPort: 'out',
    to: 'analysis-node',
    toPort: 'in',
    type: 'flow',
  });

  return { nodes, connections };
}
