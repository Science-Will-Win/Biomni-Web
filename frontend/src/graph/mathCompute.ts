// ============================================
// Math Broadcasting & Compute Utility
// Supports: scalar, vector (number[]), matrix (number[]), color (number[4]), string
// Broadcasting rules: scalar ↔ array = element-wise, array ↔ array = element-wise (same length)
// ============================================

type MathValue = number | number[] | string;

/** Determine if a value is an array type (vector, matrix, color) */
function isArray(v: MathValue): v is number[] {
  return Array.isArray(v);
}

/** Broadcast binary operation: applies op element-wise when needed */
function broadcastBinary(a: MathValue, b: MathValue, op: (x: number, y: number) => number): MathValue {
  // string concat (Add only — caller decides)
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a) + String(b);
  }

  // scalar ⊕ scalar
  if (typeof a === 'number' && typeof b === 'number') {
    return op(a, b);
  }

  // array ⊕ scalar → element-wise
  if (isArray(a) && typeof b === 'number') {
    return a.map(x => op(x, b));
  }

  // scalar ⊕ array → element-wise
  if (typeof a === 'number' && isArray(b)) {
    return b.map(y => op(a, y));
  }

  // array ⊕ array → element-wise (same length)
  if (isArray(a) && isArray(b)) {
    const len = Math.max(a.length, b.length);
    return Array.from({ length: len }, (_, i) => op(a[i] ?? 0, b[i] ?? 0));
  }

  return 0;
}

/** Broadcast unary operation: applies op element-wise when needed */
function broadcastUnary(v: MathValue, op: (x: number) => number): MathValue {
  if (typeof v === 'number') return op(v);
  if (isArray(v)) return v.map(x => op(x));
  return 0;
}

// ---- Operations ----

export function computeAdd(a: MathValue, b: MathValue): MathValue {
  // String concat special case
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a) + String(b);
  }
  return broadcastBinary(a, b, (x, y) => x + y);
}

export function computeSubtract(a: MathValue, b: MathValue): MathValue {
  return broadcastBinary(a, b, (x, y) => x - y);
}

export function computeMultiply(a: MathValue, b: MathValue): MathValue {
  return broadcastBinary(a, b, (x, y) => x * y);
}

export function computeDivide(a: MathValue, b: MathValue): MathValue {
  return broadcastBinary(a, b, (x, y) => y !== 0 ? x / y : Infinity);
}

export function computePower(base: MathValue, exp: MathValue): MathValue {
  return broadcastBinary(base, exp, (x, y) => Math.pow(x, y));
}

export function computeSqrt(value: MathValue): MathValue {
  return broadcastUnary(value, x => Math.sqrt(x));
}

export function computeLog(value: MathValue, base: MathValue): MathValue {
  return broadcastBinary(value, base, (v, b) =>
    b > 0 && b !== 1 ? Math.log(v) / Math.log(b) : 0
  );
}

// ---- Dispatcher ----

export type ComputeOp = 'compute_add' | 'compute_subtract' | 'compute_multiply' |
  'compute_divide' | 'compute_power' | 'compute_sqrt' | 'compute_log';

/**
 * Execute a math operation with broadcasting support.
 * @param tool - tool name (e.g., 'compute_add')
 * @param portValues - { a, b } or { value, base } etc.
 */
export function executeMathOp(tool: string, portValues: Record<string, unknown>): MathValue {
  const get = (key: string): MathValue => {
    const v = portValues[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v as number[];
    return 0;
  };

  switch (tool) {
    case 'compute_add':      return computeAdd(get('a'), get('b'));
    case 'compute_subtract': return computeSubtract(get('a'), get('b'));
    case 'compute_multiply': return computeMultiply(get('a'), get('b'));
    case 'compute_divide':   return computeDivide(get('a'), get('b'));
    case 'compute_power':    return computePower(get('base'), get('exp'));
    case 'compute_sqrt':     return computeSqrt(get('value'));
    case 'compute_log':      return computeLog(get('value'), get('base'));
    default: return 0;
  }
}
