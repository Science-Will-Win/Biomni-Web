// ============================================
// Auto-loader: imports all node files in this directory
// Each .tsx file self-registers via registerNode() side-effect
// To add a new node type: just create a new .tsx file here
// ============================================

const modules = import.meta.glob('./*.tsx', { eager: true });

// Force TypeScript to keep the import (side-effect only)
void modules;

// ── Dynamic node registration (Tool, Library, DataLake from backend API) ──

let _dynamicInitialized = false;
let _dynamicPromise: Promise<void> | null = null;

export async function initDynamicNodes(): Promise<void> {
  if (_dynamicInitialized) return;
  if (_dynamicPromise) return _dynamicPromise;

  _dynamicPromise = (async () => {
    try {
      const [{ registerBiomniTools }, { registerBiomniLibraries }, { registerBiomniDataLake }] =
        await Promise.all([
          import('./ToolNodes'),
          import('./LibraryNode'),
          import('./DataLakeNode'),
        ]);

      await Promise.all([
        registerBiomniTools(),
        registerBiomniLibraries(),
        registerBiomniDataLake(),
      ]);

      _dynamicInitialized = true;
      console.log('[nodes] Dynamic node registration complete');
    } catch (e) {
      console.warn('[nodes] Dynamic node registration failed:', e);
    }
  })();

  return _dynamicPromise;
}
