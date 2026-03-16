// ============================================
// Biomni Tool/Library/DataLake API service
// Fetches definitions from backend and caches them
// ============================================

export interface BiomniToolParam {
  name: string;
  type: string;        // "str", "int", "bool", "pd.DataFrame", "list", etc.
  description: string;
  default: unknown;    // null means required
}

export interface BiomniToolDef {
  name: string;
  description: string;
  module: string;
  required_parameters: BiomniToolParam[];
  optional_parameters: BiomniToolParam[];
}

export interface BiomniLibraryDef {
  name: string;
  description: string;
}

export interface BiomniDataLakeDef {
  name: string;
  description: string;
}

// ── Caches ──

let toolCache: Record<string, BiomniToolDef[]> | null = null;
let libraryCache: BiomniLibraryDef[] | null = null;
let dataLakeCache: BiomniDataLakeDef[] | null = null;

const API_BASE = '/api';

// ── Fetch functions ──

export async function fetchBiomniTools(): Promise<Record<string, BiomniToolDef[]>> {
  if (toolCache) return toolCache;
  try {
    const res = await fetch(`${API_BASE}/tools`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Tag each tool with its module name if not already present
    for (const [module, tools] of Object.entries(data as Record<string, BiomniToolDef[]>)) {
      for (const tool of tools) {
        if (!tool.module) tool.module = module;
      }
    }
    toolCache = data;
    return data;
  } catch (e) {
    console.warn('Failed to fetch Biomni tools:', e);
    return {};
  }
}

export async function fetchBiomniLibraries(): Promise<BiomniLibraryDef[]> {
  if (libraryCache) return libraryCache;
  try {
    const res = await fetch(`${API_BASE}/libraries`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    libraryCache = await res.json();
    return libraryCache!;
  } catch (e) {
    console.warn('Failed to fetch Biomni libraries:', e);
    return [];
  }
}

export async function fetchBiomniDataLake(): Promise<BiomniDataLakeDef[]> {
  if (dataLakeCache) return dataLakeCache;
  try {
    const res = await fetch(`${API_BASE}/data-lake`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dataLakeCache = await res.json();
    return dataLakeCache!;
  } catch (e) {
    console.warn('Failed to fetch Biomni data lake:', e);
    return [];
  }
}

// ── Helpers ──

/** Map Python type string to PortType */
export function pythonTypeToPortType(pyType: string): 'string' | 'int' | 'boolean' | 'data' | 'any' {
  const t = pyType.toLowerCase().replace(/\s/g, '');
  if (t === 'str' || t === 'string') return 'string';
  if (t === 'int' || t === 'integer') return 'int';
  if (t === 'bool' || t === 'boolean') return 'boolean';
  if (t.includes('dataframe') || t === 'pd.dataframe') return 'data';
  return 'any';
}

/** Convert module name to human-readable label */
const MODULE_LABELS: Record<string, { en: string; ko: string }> = {
  literature: { en: 'Literature', ko: '문헌 검색' },
  database: { en: 'Database', ko: '데이터베이스' },
  genomics: { en: 'Genomics', ko: '유전체학' },
  genetics: { en: 'Genetics', ko: '유전학' },
  pharmacology: { en: 'Pharmacology', ko: '약리학' },
  bioimaging: { en: 'Bioimaging', ko: '바이오이미징' },
  molecular_biology: { en: 'Molecular Biology', ko: '분자생물학' },
  microbiology: { en: 'Microbiology', ko: '미생물학' },
  physiology: { en: 'Physiology', ko: '생리학' },
  immunology: { en: 'Immunology', ko: '면역학' },
  biochemistry: { en: 'Biochemistry', ko: '생화학' },
  bioengineering: { en: 'Bioengineering', ko: '생공학' },
  synthetic_biology: { en: 'Synthetic Biology', ko: '합성생물학' },
  systems_biology: { en: 'Systems Biology', ko: '시스템생물학' },
  cancer_biology: { en: 'Cancer Biology', ko: '암생물학' },
  pathology: { en: 'Pathology', ko: '병리학' },
  cell_biology: { en: 'Cell Biology', ko: '세포생물학' },
  protocols: { en: 'Protocols', ko: '프로토콜' },
  support_tools: { en: 'Support', ko: '지원 도구' },
  lab_automation: { en: 'Lab Automation', ko: '실험 자동화' },
  biophysics: { en: 'Biophysics', ko: '생물물리학' },
  glycoengineering: { en: 'Glycoengineering', ko: '당공학' },
};

export function getModuleLabel(module: string): { en: string; ko: string } {
  return MODULE_LABELS[module] ?? {
    en: module.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    ko: module.replace(/_/g, ' '),
  };
}
