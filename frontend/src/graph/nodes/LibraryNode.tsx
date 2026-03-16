// ============================================
// Biomni Library Nodes — dynamically registered from backend API
// Each library gets its own node type (read-only, reference-only)
// ============================================

import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { fetchBiomniLibraries } from '../tool-service';

const LIB_PORTS = [{ name: 'out', dir: 'out' as const, type: 'string' as const }];

function LibraryNodeComponent({ node }: NodeComponentProps) {
  const desc = node.description || '';
  return (
    <>
      <div className="ng-node-header">
        <span className="ng-node-title">{node.title}</span>
      </div>
      {desc && (
        <div className="ng-node-body ng-library-body">
          <span className="ng-library-desc">{desc.length > 120 ? desc.slice(0, 117) + '...' : desc}</span>
        </div>
      )}
      <PortRow nodeId={node.id} ports={LIB_PORTS} dir="out" />
    </>
  );
}

export async function registerBiomniLibraries(): Promise<number> {
  const libraries = await fetchBiomniLibraries();
  let count = 0;

  for (const lib of libraries) {
    const nodeId = `lib_${lib.name}`;

    registerNode(nodeId, {
      label: lib.name,
      category: 'Library',
      dataOnly: true,
      ports: LIB_PORTS,
      defaultConfig: {
        title: lib.name,
        status: 'completed',
        portValues: { out: lib.name },
        menuTag: { en: 'Library', ko: '라이브러리' },
        description: { en: lib.description, ko: lib.description },
      },
      component: (props: NodeComponentProps) => (
        <LibraryNodeComponent {...props} />
      ),
    });
    count++;
  }

  console.log(`[LibraryNode] Registered ${count} Biomni libraries`);
  return count;
}
