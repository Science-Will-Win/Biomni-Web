import { useState } from 'react';
import { registerNode } from '../node-registry';
import type { NodeComponentProps } from '../node-registry';
import { PortRow } from '../components/PortRow';

const PORTS = [{ name: 'out', dir: 'out' as const, type: 'color' as const }];

function rgbaToHex(rgba: number[]): string {
  const r = Math.round(rgba[0] ?? 255).toString(16).padStart(2, '0');
  const g = Math.round(rgba[1] ?? 255).toString(16).padStart(2, '0');
  const b = Math.round(rgba[2] ?? 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

function hexToRgba(hex: string, alpha: number): number[] {
  const clean = hex.replace('#', '').slice(0, 6).padEnd(6, 'f');
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return [r, g, b, alpha];
}

function ColorNodeComponent({ node, onPortValueChange }: NodeComponentProps) {
  const val = (node.portValues?.out as number[]) ?? [255, 255, 255, 1.0];
  const hex = rgbaToHex(val);
  const [hexInput, setHexInput] = useState(hex);

  const updateColor = (newVal: number[]) => {
    onPortValueChange?.(node.id, 'out', newVal);
    setHexInput(rgbaToHex(newVal));
  };

  const handleHexChange = (input: string) => {
    setHexInput(input);
    if (/^#?[0-9a-fA-F]{6}$/.test(input.replace('#', ''))) {
      const h = input.startsWith('#') ? input : `#${input}`;
      onPortValueChange?.(node.id, 'out', hexToRgba(h, val[3] ?? 1));
    }
  };

  const handleRgbaChange = (index: number, raw: string) => {
    const parsed = index < 3 ? parseInt(raw) : parseFloat(raw);
    const fallback = index < 3 ? 0 : 0;
    const num = isNaN(parsed) ? fallback : (index < 3 ? Math.max(0, Math.min(255, parsed)) : Math.max(0, Math.min(1, parsed)));
    const newVal = [...val];
    newVal[index] = num;
    updateColor(newVal);
  };

  return (
    <>
      <div className="ng-node-header"><span className="ng-node-title">{node.title}</span></div>
      <div className="ng-input-node-body">
        <div className="ng-color-row">
          <input type="color" value={hex} className="ng-color-picker ng-interactive"
            onChange={e => updateColor(hexToRgba(e.target.value, val[3] ?? 1))}
            onMouseDown={e => e.stopPropagation()} />
          <input type="text" value={hexInput} className="ng-input-node-field ng-interactive ng-color-hex"
            onChange={e => handleHexChange(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            placeholder="#FFFFFF" />
        </div>
        <div className="ng-color-fields">
          {['R', 'G', 'B', 'A'].map((label, i) => (
            <label key={label} className="ng-color-field-label">
              <span>{label}</span>
              <input type="number"
                min={i < 3 ? 0 : 0} max={i < 3 ? 255 : 1} step={i < 3 ? 1 : 0.1}
                className="ng-matrix-cell ng-interactive"
                value={val[i] ?? (i < 3 ? 255 : 1)}
                onChange={e => handleRgbaChange(i, e.target.value)}
                onBlur={e => { e.target.value = String(val[i] ?? (i < 3 ? 255 : 1)); }}
                onMouseDown={e => e.stopPropagation()} />
            </label>
          ))}
        </div>
      </div>
      <PortRow nodeId={node.id} ports={PORTS} dir="out" />
    </>
  );
}

registerNode('color_value', {
  label: 'Color', category: 'Input', dataOnly: true, ports: PORTS,
  defaultConfig: {
    title: 'Color', status: 'completed', portValues: { out: [255, 255, 255, 1.0] },
    menuTag: { en: 'Color', ko: '색상' },
    description: { en: 'RGBA color input with color picker', ko: 'RGBA 색상 입력' },
  },
  component: ColorNodeComponent,
});
