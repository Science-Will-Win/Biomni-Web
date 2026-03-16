// ============================================
// Step Node Type
// ============================================

import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { NodeHeader } from '../components/NodeHeader';
import { PortRow } from '../components/PortRow';
import { ProgressBar } from '../components/ProgressBar';

const PORTS = [
  { name: 'in', dir: 'in' as const, type: 'any' as const },
  { name: 'out', dir: 'out' as const, type: 'any' as const },
];

function StepNodeComponent({ node, onTitleChange }: NodeComponentProps) {
  return (
    <>
      <PortRow nodeId={node.id} ports={PORTS} dir="in" />
      <NodeHeader
        stepNum={node.stepNum}
        title={node.title}
        nodeId={node.id}
        onTitleChange={onTitleChange}
      />
      <div className="ng-node-body">{node.description || '\u00A0'}</div>
      <ProgressBar />
      <PortRow nodeId={node.id} ports={PORTS} dir="out" />
    </>
  );
}

registerNode('step', {
  label: 'Step',
  category: 'General',
  allowRef: true,
  ports: PORTS,
  defaultConfig: {
    title: 'Step',
    tool: '',
    status: 'pending',
    stepNum: '',
    menuTag: { en: 'Execution', ko: '실행', ja: '実行', zh: '执行' },
    description: {
      en: 'General-purpose execution step for running tools and actions',
      ko: '도구와 액션을 실행하는 범용 실행 단계',
    },
  },
  component: StepNodeComponent,
});
