// ============================================
// Create Node Menu — shows on double-click in empty area
// ============================================

import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getByCategory } from '../node-registry';
import type { NodeDefinition } from '../node-registry';
import type { I18nField, NodeData, NodeStatus } from '../types';

interface CreateNodeMenuProps {
  x: number;
  y: number;
  onSelect: (type: string) => void;
  onClose: () => void;
}

// Module-level: persists toggle state across menu open/close within session
let sessionExpandedCats: Set<string> = new Set();

function resolveI18n(field?: I18nField): string {
  if (!field) return '';
  const lang = document.documentElement.lang || 'en';
  return field[lang] || field.en || Object.values(field)[0] || '';
}

// ---- Node Preview Popup ----

function NodePreviewPopup({ type, definition, itemRect, menuRect }: {
  type: string;
  definition: NodeDefinition;
  itemRect: DOMRect;
  menuRect: DOMRect;
}) {
  const mockNode = useMemo<NodeData>(() => ({
    id: '__preview__',
    type,
    title: definition.defaultConfig.title || definition.label,
    tool: definition.defaultConfig.tool,
    x: 0, y: 0,
    width: definition.minWidth || 180,
    height: 80,
    status: (definition.defaultConfig.status as NodeStatus) || 'pending',
    stepNum: definition.defaultConfig.stepNum,
    portValues: definition.defaultConfig.portValues
      ? { ...definition.defaultConfig.portValues }
      : undefined,
  }), [type, definition]);

  const Component = definition.component;
  const desc = resolveI18n(definition.defaultConfig.description);

  // Position: right of menu (or left if not enough space) — matches original node-graph.js:2130-2140
  const spaceRight = window.innerWidth - menuRect.right;
  const left = spaceRight >= 240
    ? menuRect.right + 8
    : menuRect.left - 240;
  const top = Math.max(8, itemRect.top - 10);

  return (
    <div className="ng-node-preview-popup" style={{ left, top }}>
      {desc && (
        <div className="ng-node-preview-desc">{desc}</div>
      )}
      <div className="ng-node-preview-render">
        <div className={`ng-node ng-status-${mockNode.status || 'pending'} ng-cat-${(definition.category || 'General').toLowerCase().replace(/\s+/g, '-')}`}>
          <Component node={mockNode} />
        </div>
      </div>
    </div>
  );
}

// ---- Main Menu Component ----

export function CreateNodeMenu({ x, y, onSelect, onClose }: CreateNodeMenuProps) {
  const [search, setSearch] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(sessionExpandedCats);
  const [hoveredItem, setHoveredItem] = useState<{
    type: string;
    definition: NodeDefinition;
    itemRect: DOMRect;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const categories = getByCategory();
  const lowerSearch = search.toLowerCase();

  const toggleCategory = (cat: string) => {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      sessionExpandedCats = next;
      return next;
    });
  };

  return (
    <div
      ref={menuRef}
      className="ng-create-menu"
      style={{ left: x, top: y }}
    >
      <div className="ng-create-menu-title">Create Node</div>
      <div className="ng-create-menu-search-wrap">
        <span className="ng-create-menu-search-icon">🔍</span>
        <input
          ref={searchRef}
          className="ng-create-menu-search"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="ng-create-menu-list">
        {Object.entries(categories).map(([cat, items]) => {
          const filtered = items.filter(item => {
            if (!lowerSearch) return true;
            const label = item.label.toLowerCase();
            const tag = resolveI18n(item.definition.defaultConfig.menuTag).toLowerCase();
            const desc = resolveI18n(item.definition.defaultConfig.description).toLowerCase();
            return label.includes(lowerSearch) || tag.includes(lowerSearch) || desc.includes(lowerSearch);
          });
          if (filtered.length === 0) return null;
          const isExpanded = expandedCats.has(cat) || !!search;

          // Group by subcategory if any items have one
          const hasSubcats = filtered.some(i => i.definition.subcategory);
          const subcatGroups: Record<string, typeof filtered> = {};
          const noSubcat: typeof filtered = [];
          if (hasSubcats) {
            for (const item of filtered) {
              const sub = item.definition.subcategory;
              if (sub) {
                (subcatGroups[sub] ??= []).push(item);
              } else {
                noSubcat.push(item);
              }
            }
          }

          const renderItem = (item: typeof filtered[0]) => (
            <div
              key={item.type}
              className="ng-create-menu-item"
              onClick={() => onSelect(item.type)}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setHoveredItem({ type: item.type, definition: item.definition, itemRect: rect });
              }}
              onMouseLeave={() => setHoveredItem(null)}
            >
              <div className="ng-create-menu-item-name">{item.label}</div>
              <div className="ng-create-menu-item-desc">
                {resolveI18n(item.definition.defaultConfig.description)}
              </div>
            </div>
          );

          return (
            <div key={cat} className={isExpanded ? 'ng-cat-expanded' : ''}>
              <div
                className="ng-create-menu-category-header"
                onClick={() => toggleCategory(cat)}
              >
                <span className="ng-create-menu-cat-arrow">{isExpanded ? '▼' : '▶'}</span>
                <span>{cat}</span>
                <span style={{ opacity: 0.4, marginLeft: 'auto', fontSize: 11 }}>{filtered.length}</span>
              </div>
              <div className="ng-create-menu-items">
                {hasSubcats ? (
                  <>
                    {noSubcat.map(renderItem)}
                    {Object.entries(subcatGroups)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([subcat, subItems]) => {
                        const subKey = `${cat}/${subcat}`;
                        const subExpanded = expandedCats.has(subKey) || !!search;
                        return (
                          <div key={subKey} className={subExpanded ? 'ng-cat-expanded' : ''}>
                            <div
                              className="ng-create-menu-subcategory-header"
                              onClick={() => toggleCategory(subKey)}
                            >
                              <span className="ng-create-menu-cat-arrow">{subExpanded ? '▼' : '▶'}</span>
                              <span>{subcat}</span>
                              <span style={{ opacity: 0.4, marginLeft: 'auto', fontSize: 11 }}>{subItems.length}</span>
                            </div>
                            <div className="ng-create-menu-items">
                              {subItems.map(renderItem)}
                            </div>
                          </div>
                        );
                      })}
                  </>
                ) : (
                  filtered.map(renderItem)
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Node Preview Popup — portaled to body to avoid menu overflow clip */}
      {hoveredItem && menuRef.current && createPortal(
        <NodePreviewPopup
          type={hoveredItem.type}
          definition={hoveredItem.definition}
          itemRect={hoveredItem.itemRect}
          menuRect={menuRef.current.getBoundingClientRect()}
        />,
        document.body,
      )}
    </div>
  );
}
