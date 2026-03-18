// ============================================
// Biomni Data Lake Nodes — dynamically registered from backend API
// Each dataset gets its own node type (read-only, data-only)
// ============================================

import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';
import { fetchBiomniDataLake } from '../tool-service';

const DL_PORTS = [{ name: 'out', dir: 'out' as const, type: 'data' as const }];

function DataLakeNodeComponent({ node }: NodeComponentProps) {
  const desc = node.description || '';
  return (
    <>
      <div className="ng-node-header">
        <span className="ng-node-title">{node.title}</span>
      </div>
      {desc && (
        <div className="ng-node-body ng-datalake-body">
          <span className="ng-datalake-desc">{desc.length > 120 ? desc.slice(0, 117) + '...' : desc}</span>
        </div>
      )}
      <PortRow nodeId={node.id} ports={DL_PORTS} dir="out" />
    </>
  );
}

/** Sanitize dataset name for use as node ID */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

export async function registerBiomniDataLake(): Promise<number> {
  const datasets = await fetchBiomniDataLake();
  let count = 0;

  for (const ds of datasets) {
    const nodeId = `dl_${sanitizeName(ds.name)}`;

    registerNode(nodeId, {
      label: ds.name,
      category: 'Data',
      subcategory: 'Data Lake',
      dataOnly: true,
      ports: DL_PORTS,
      defaultConfig: {
        title: ds.name,
        status: 'completed',
        portValues: { out: { datasetName: ds.name, description: ds.description } },
        menuTag: { en: 'Data Lake', ko: '데이터 레이크' },
        description: { en: ds.description, ko: ds.description },
      },
      component: (props: NodeComponentProps) => (
        <DataLakeNodeComponent {...props} />
      ),
    });
    count++;
  }

  console.log(`[DataLakeNode] Registered ${count} Biomni data lake datasets`);
  return count;
}
