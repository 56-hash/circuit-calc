// AST 평가기: 복소수, 행렬, 함수, 수치 미적분.

import * as K from './complex.js';
import { Complex, C, CalcError } from './complex.js';
import { containsAngle } from './parser.js';

export class Matrix {
  constructor(rows) {
    this.rows = rows; // Complex[][]
  }
  get n() { return this.rows.length; }
  get m() { return this.rows[0]?.length ?? 0; }
  static identity(n) {
    return new Matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => C(i === j ? 1 : 0))));
  }
}
export const isMat = (v) => v instanceof Matrix;

const ZERO = C(0);

function map2(a, b, f, what) {
  if (a.n !== b.n || a.m !== b.m) throw new CalcError('dim', `${what}: 행렬 크기가 다릅니다 (${a.n}x${a.m} 와 ${b.n}x${b.m})`);
  return new Matrix(a.rows.map((r, i) => r.map((x, j) => f(x, b.rows[i][j]))));
}

export function matMul(a, b) {
  if (a.m !== b.n) throw new CalcError('dim', `행렬 곱: 크기가 맞지 않습니다 (${a.n}x${a.m} 와 ${b.n}x${b.m})`);
  const out = [];
  for (let i = 0; i < a.n; i++) {
    const row = [];
    for (let j = 0; j < b.m; j++) {
      let s = ZERO;
      for (let k = 0; k < a.m; k++) s = K.add(s, K.mul(a.rows[i][k], b.rows[k][j]));
      row.push(s);
    }
    out.push(row);
  }
  return new Matrix(out);
}

// LU(부분 피벗)로 행렬식과 역행렬 계산
function luDecompose(M) {
  const n = M.n;
  if (n !== M.m) throw new CalcError('dim', '정방행렬이 필요합니다');
  const a = M.rows.map((r) => r.slice());
  const perm = Array.from({ length: n }, (_, i) => i);
  let sign = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    let best = a[c][c].abs;
    for (let r = c + 1; r < n; r++) if (a[r][c].abs > best) { best = a[r][c].abs; p = r; }
    if (best < 1e-300) return { singular: true, a, perm, sign };
    if (p !== c) { [a[p], a[c]] = [a[c], a[p]]; [perm[p], perm[c]] = [perm[c], perm[p]]; sign = -sign; }
    for (let r = c + 1; r < n; r++) {
      const f = K.div(a[r][c], a[c][c]);
      a[r][c] = f;
      for (let k = c + 1; k < n; k++) a[r][k] = K.sub(a[r][k], K.mul(f, a[c][k]));
    }
  }
  return { singular: false, a, perm, sign };
}

export function det(M) {
  const { singular, a, sign } = luDecompose(M);
  if (singular) return C(0);
  let d = C(sign);
  for (let i = 0; i < M.n; i++) d = K.mul(d, a[i][i]);
  return d;
}

export function inv(M) {
  const n = M.n;
  const { singular, a, perm } = luDecompose(M);
  if (singular) throw new CalcError('singular', '특이행렬이라 역행렬이 없습니다');
  const cols = [];
  for (let c = 0; c < n; c++) {
    const b = Array.from({ length: n }, (_, i) => (perm[i] === c ? C(1) : C(0)));
    for (let i = 0; i < n; i++) for (let k = 0; k < i; k++) b[i] = K.sub(b[i], K.mul(a[i][k], b[k]));
    for (let i = n - 1; i >= 0; i--) {
      for (let k = i + 1; k < n; k++) b[i] = K.sub(b[i], K.mul(a[i][k], b[k]));
      b[i] = K.div(b[i], a[i][i]);
    }
    cols.push(b);
  }
  return new Matrix(Array.from({ length: n }, (_, i) => cols.map((col) => col[i])));
}

// 복소 선형계 A x = b 풀이 (부분 피벗 가우스 소거). 반환: {x} 또는 {singular:true, rank}
export function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]]);
  let rank = 0;
  const m = A[0].length;
  const pivCols = [];
  let row = 0;
  for (let c = 0; c < m && row < n; c++) {
    let p = row;
    let best = M[row][c].abs;
    for (let r = row + 1; r < n; r++) if (M[r][c].abs > best) { best = M[r][c].abs; p = r; }
    let scaleRef = 0;
    for (let r = 0; r < n; r++) scaleRef = Math.max(scaleRef, M[r][c].abs);
    if (best <= 1e-12 * Math.max(scaleRef, 1e-300) || best === 0) continue;
    [M[p], M[row]] = [M[row], M[p]];
    for (let r = 0; r < n; r++) {
      if (r === row) continue;
      const f = K.div(M[r][c], M[row][c]);
      if (f.abs === 0) continue;
      for (let k = c; k <= m; k++) M[r][k] = K.sub(M[r][k], K.mul(f, M[row][k]));
    }
    pivCols.push(c);
    row++;
    rank++;
  }
  // 모순 검사: 영행 + 0이 아닌 우변
  let inconsistent = false;
  const bScale = Math.max(1e-300, ...b.map((x) => x.abs));
  for (let r = rank; r < n; r++) if (M[r][m].abs > 1e-9 * Math.max(1, bScale)) inconsistent = true;
  if (inconsistent) return { inconsistent: true, rank };
  if (rank < m) return { singular: true, rank };
  const x = Array.from({ length: m }, () => ZERO);
  pivCols.forEach((c, r) => { x[c] = K.div(M[r][m], M[r][c]); });
  return { x, rank };
}

// ---- 감마/계승 ----
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function gammaReal(x) {
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaReal(1 - x));
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}
function factorial(x) {
  if (Number.isInteger(x)) {
    if (x < 0) throw new CalcError('domain', '음의 정수의 계승은 정의되지 않습니다');
    if (x > 170) throw new CalcError('domain', '계승이 너무 큽니다 (170 이하)');
    let r = 1;
    for (let i = 2; i <= x; i++) r *= i;
    return r;
  }
  return gammaReal(x + 1);
}

// ---- 수치 적분 (적응형 가우스-크론로드 15점) ----
const GK_X = [0.991455371120813, 0.949107912342759, 0.864864423359769, 0.741531185599394, 0.58608723546769, 0.405845151377397, 0.207784955007898, 0];
const GK_WK = [0.022935322010529, 0.063092092629979, 0.104790010322250, 0.140653259715525, 0.169004726639267, 0.190350578064785, 0.204432940075298, 0.209482141084728];
const GK_WG = [0, 0.129484966168870, 0, 0.279705391489277, 0, 0.381830050505119, 0, 0.417959183673469];

function gk15(f, a, b) {
  const c = (a + b) / 2;
  const h = (b - a) / 2;
  const fc = f(c);
  let k = K.scale(fc, GK_WK[7]);
  let g = K.scale(fc, GK_WG[7]);
  for (let i = 0; i < 7; i++) {
    const dx = h * GK_X[i];
    const s = K.add(f(c - dx), f(c + dx));
    k = K.add(k, K.scale(s, GK_WK[i]));
    g = K.add(g, K.scale(s, GK_WG[i]));
  }
  return { val: K.scale(k, h), err: K.sub(K.scale(k, h), K.scale(g, h)).abs };
}
export function integrate(f, a, b, tol = 1e-10) {
  if (a === b) return C(0);
  const sign = a < b ? 1 : -1;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const rec = (x0, x1, depth, whole) => {
    const mid = (x0 + x1) / 2;
    const L = gk15(f, x0, mid);
    const R = gk15(f, mid, x1);
    const sum = K.add(L.val, R.val);
    const err = L.err + R.err;
    if (depth >= 18 || err <= tol * Math.max(1, sum.abs)) return sum;
    return K.add(rec(x0, mid, depth + 1), rec(mid, x1, depth + 1));
  };
  const whole = gk15(f, lo, hi);
  const total = whole.err <= tol * Math.max(1, whole.val.abs) ? whole.val : rec(lo, hi, 0);
  if (!total.isFiniteNum()) throw new CalcError('domain', '적분 값이 발산하거나 정의되지 않습니다');
  return K.scale(total, sign);
}

// ---- 수치 미분 (Ridders) ----
export function derivative(f, x0) {
  const NTAB = 10;
  const CON = 1.4;
  const CON2 = CON * CON;
  const SAFE = 2;
  let h = 0.1 * Math.max(1, Math.abs(x0));
  const a = Array.from({ length: NTAB }, () => new Array(NTAB));
  let best = null;
  let err = Infinity;
  a[0][0] = K.scale(K.sub(f(x0 + h), f(x0 - h)), 1 / (2 * h));
  for (let i = 1; i < NTAB; i++) {
    h /= CON;
    a[0][i] = K.scale(K.sub(f(x0 + h), f(x0 - h)), 1 / (2 * h));
    let fac = CON2;
    for (let j = 1; j <= i; j++) {
      a[j][i] = K.scale(K.sub(K.scale(a[j - 1][i], fac), a[j - 1][i - 1]), 1 / (fac - 1));
      fac *= CON2;
      const e = Math.max(K.sub(a[j][i], a[j - 1][i]).abs, K.sub(a[j][i], a[j - 1][i - 1]).abs);
      if (e <= err) { err = e; best = a[j][i]; }
    }
    if (K.sub(a[i][i], a[i - 1][i - 1]).abs >= SAFE * err) break;
  }
  if (!best.isFiniteNum()) throw new CalcError('domain', '미분할 수 없는 점입니다');
  return best;
}

// ---- 평가 ----
export function createContext(init = {}) {
  return {
    env: init.env ?? new Map(),
    angleMode: init.angleMode ?? 'deg',
    ans: init.ans ?? null,
    results: init.results ?? new Map(),
  };
}

function asReal(v, what = '값') {
  if (isMat(v)) throw new CalcError('type', `${what}: 행렬은 사용할 수 없습니다`);
  if (!v.isReal(1e-9)) throw new CalcError('type', `${what}: 실수가 필요합니다`);
  return v.re;
}
function asScalar(v, what) {
  if (isMat(v)) throw new CalcError('type', `${what}: 스칼라가 필요합니다 (행렬 불가)`);
  return v;
}
function asInt(v, what) {
  const x = asReal(v, what);
  if (!Number.isInteger(Math.round(x * 1e9) / 1e9)) throw new CalcError('type', `${what}: 정수가 필요합니다`);
  return Math.round(x);
}

function toRad(ctx, ast, v) {
  if (ctx.angleMode === 'rad' || (ast && containsAngle(ast))) return v;
  return K.scale(v, Math.PI / 180);
}
function fromRad(ctx, v) {
  return ctx.angleMode === 'deg' ? K.scale(v, 180 / Math.PI) : v;
}

function withVar(ctx, name, value, fn) {
  const had = ctx.env.has(name);
  const prev = ctx.env.get(name);
  ctx.env.set(name, value);
  try { return fn(); } finally {
    if (had) ctx.env.set(name, prev); else ctx.env.delete(name);
  }
}

function binary(op, a, b) {
  const am = isMat(a), bm = isMat(b);
  switch (op) {
    case '+': if (am && bm) return map2(a, b, K.add, '행렬 덧셈'); if (am || bm) throw new CalcError('type', '행렬과 스칼라는 더할 수 없습니다'); return K.add(a, b);
    case '-': if (am && bm) return map2(a, b, K.sub, '행렬 뺄셈'); if (am || bm) throw new CalcError('type', '행렬과 스칼라는 뺄 수 없습니다'); return K.sub(a, b);
    case '*':
      if (am && bm) return matMul(a, b);
      if (am) return new Matrix(a.rows.map((r) => r.map((x) => K.mul(x, b))));
      if (bm) return new Matrix(b.rows.map((r) => r.map((x) => K.mul(a, x))));
      return K.mul(a, b);
    case '/':
      if (am && bm) return matMul(a, inv(b));
      if (am) return new Matrix(a.rows.map((r) => r.map((x) => K.div(x, b))));
      if (bm) throw new CalcError('type', '스칼라를 행렬로 나눌 수 없습니다');
      return K.div(a, b);
    case '^':
      if (am) {
        if (bm) throw new CalcError('type', '행렬 지수는 지원하지 않습니다');
        const p = asInt(b, '행렬 거듭제곱');
        if (a.n !== a.m) throw new CalcError('dim', '정방행렬이 필요합니다');
        let base = p < 0 ? inv(a) : a;
        let n = Math.abs(p);
        let r = Matrix.identity(a.n);
        while (n > 0) { if (n & 1) r = matMul(r, base); base = matMul(base, base); n >>= 1; }
        return r;
      }
      if (bm) throw new CalcError('type', '행렬 지수는 지원하지 않습니다');
      return K.pow(a, b);
    case '||': {
      if (am || bm) throw new CalcError('type', '병렬 합성(||)은 스칼라에만 사용할 수 있습니다');
      if (a.abs === 0 || b.abs === 0) return C(0);
      const s = K.add(a, b);
      if (s.abs === 0) throw new CalcError('div0', '병렬 합성: 두 값의 합이 0입니다');
      return K.div(K.mul(a, b), s);
    }
    default: throw new CalcError('parse', `알 수 없는 연산자 ${op}`);
  }
}

export function evaluate(ast, ctx) {
  switch (ast.k) {
    case 'num': return ast.angle ? ast.v : ast.v;
    case 'paren': return evaluate(ast.a, ctx);
    case 'id': return lookup(ast.name, ctx);
    case 'un': {
      const v = evaluate(ast.a, ctx);
      return isMat(v) ? new Matrix(v.rows.map((r) => r.map(K.neg))) : K.neg(v);
    }
    case 'bin': return binary(ast.op, evaluate(ast.a, ctx), evaluate(ast.b, ctx));
    case 'fact': {
      const v = asScalar(evaluate(ast.a, ctx), '계승');
      return C(factorial(asReal(v, '계승')));
    }
    case 'polar': {
      const r = asScalar(evaluate(ast.a, ctx), '극형식 크기');
      const th = asScalar(evaluate(ast.b, ctx), '극형식 각도');
      const rad = toRad(ctx, ast.b, th);
      return K.mul(r, K.exp(K.mul(K.J, rad)));
    }
    case 'mat': return new Matrix(ast.rows.map((r) => r.map((e) => asScalar(evaluate(e, ctx), '행렬 원소'))));
    case 'eq': throw new CalcError('type', "'=' 는 solve() 안에서만 사용할 수 있습니다");
    case 'call': return callFunction(ast, ctx);
    default: throw new CalcError('parse', `알 수 없는 노드 ${ast.k}`);
  }
}

function lookup(name, ctx) {
  if (name === 'pi') return C(Math.PI);
  if (name === 'e') return C(Math.E);
  if (name === 'j') return K.J;
  if (name === 'Ans') {
    if (!ctx.ans) throw new CalcError('undef', '이전 결과(Ans)가 없습니다', { name });
    return ctx.ans;
  }
  if (name.startsWith('#')) {
    const v = ctx.results.get(Number(name.slice(1)));
    if (!v) throw new CalcError('undef', `${name} 줄의 결과가 없습니다`, { name });
    return v;
  }
  const v = ctx.env.get(name);
  if (v === undefined) {
    const err = new CalcError('undef', `${name} 값이 없습니다`);
    err.varName = name;
    throw err;
  }
  return v;
}

const real1 = (fn) => (v, name) => C(fn(asReal(v, name)));

function callFunction(ast, ctx) {
  const { name, args } = ast;
  // 수식 인자를 평가하지 않는 함수들
  if (name === 'sum' || name === 'prod') return reduceLoop(name, args, ctx);
  if (name === 'int') return integral(args, ctx);
  if (name === 'diff') return diffCall(args, ctx);
  if (name === 'solve') throw new CalcError('solve-context', 'solve()는 단독 줄로 사용하세요');

  const vals = args.map((a) => evaluate(a, ctx));
  const need = (n) => { if (vals.length !== n) throw new CalcError('arity', `${name}() 인자는 ${n}개가 필요합니다`); };
  const s0 = () => asScalar(vals[0], name);

  switch (name) {
    case 'sin': need(1); return K.sin(toRad(ctx, args[0], s0()));
    case 'cos': need(1); return K.cos(toRad(ctx, args[0], s0()));
    case 'tan': need(1); {
      const x = toRad(ctx, args[0], s0());
      if (K.cos(x).abs < 1e-15) throw new CalcError('domain', 'tan: 정의되지 않는 각도입니다');
      return K.tan(x);
    }
    case 'asin': need(1); return fromRad(ctx, K.asin(s0()));
    case 'acos': need(1); return fromRad(ctx, K.acos(s0()));
    case 'atan': need(1); return fromRad(ctx, K.atan(s0()));
    case 'atan2': need(2); return fromRad(ctx, C(Math.atan2(asReal(vals[0], 'atan2'), asReal(vals[1], 'atan2'))));
    case 'sinh': need(1); return K.sinh(s0());
    case 'cosh': need(1); return K.cosh(s0());
    case 'tanh': need(1); return K.tanh(s0());
    case 'exp': need(1); return K.exp(s0());
    case 'ln': need(1); return K.ln(s0());
    case 'log10': need(1); return K.scale(K.ln(s0()), 1 / Math.LN10);
    case 'log2': need(1); return K.scale(K.ln(s0()), 1 / Math.LN2);
    case 'log':
      if (vals.length === 2) return K.div(K.ln(asScalar(vals[0], 'log')), K.ln(asScalar(vals[1], 'log')));
      need(1); return K.scale(K.ln(s0()), 1 / Math.LN10);
    case 'sqrt': need(1); return K.sqrt(s0());
    case 'cbrt': need(1); {
      const x = s0();
      if (x.isReal()) return C(Math.cbrt(x.re));
      return K.pow(x, C(1 / 3));
    }
    case 'root': need(2); return K.pow(asScalar(vals[0], 'root'), K.div(C(1), asScalar(vals[1], 'root')));
    case 'pow': need(2); return K.pow(asScalar(vals[0], 'pow'), asScalar(vals[1], 'pow'));
    case 'abs': need(1); return C(s0().abs);
    case 'arg': need(1); return fromRad(ctx, C(s0().arg));
    case 're': need(1); return C(s0().re);
    case 'im': need(1); return C(s0().im);
    case 'conj': need(1); return K.conj(s0());
    case 'floor': need(1); return C(Math.floor(asReal(vals[0], name)));
    case 'ceil': need(1); return C(Math.ceil(asReal(vals[0], name)));
    case 'round': need(1); return C(Math.round(asReal(vals[0], name)));
    case 'trunc': need(1); return C(Math.trunc(asReal(vals[0], name)));
    case 'sign': need(1); return C(Math.sign(asReal(vals[0], name)));
    case 'min': return C(Math.min(...vals.map((v) => asReal(v, name))));
    case 'max': return C(Math.max(...vals.map((v) => asReal(v, name))));
    case 'mod': need(2); {
      const a = asReal(vals[0], name), b = asReal(vals[1], name);
      if (b === 0) throw new CalcError('div0', 'mod: 0으로 나눌 수 없습니다');
      return C(a - b * Math.floor(a / b));
    }
    case 'gcd': case 'lcm': need(2); {
      let a = Math.abs(asInt(vals[0], name)), b = Math.abs(asInt(vals[1], name));
      const x = a, y = b;
      while (b) [a, b] = [b, a % b];
      return C(name === 'gcd' ? a : (x / (a || 1)) * y);
    }
    case 'dB': need(1); return C(20 * Math.log10(s0().abs));
    case 'dBp': need(1); return C(10 * Math.log10(s0().abs));
    case 'rect': case 'polar': need(1); return vals[0];
    case 'par': {
      if (vals.length < 2) throw new CalcError('arity', 'par() 인자는 2개 이상 필요합니다');
      return vals.slice(1).reduce((acc, v) => binary('||', acc, v), vals[0]);
    }
    case 'deg': need(1); return K.scale(s0(), 180 / Math.PI);
    case 'rad': need(1); return K.scale(s0(), Math.PI / 180);
    case 'inv': need(1); if (!isMat(vals[0])) return K.div(C(1), vals[0]); return inv(vals[0]);
    case 'det': need(1); if (!isMat(vals[0])) throw new CalcError('type', 'det: 행렬이 필요합니다'); return det(vals[0]);
    case 'transpose': need(1); {
      const M = vals[0];
      if (!isMat(M)) return M;
      return new Matrix(Array.from({ length: M.m }, (_, j) => Array.from({ length: M.n }, (_, i) => M.rows[i][j])));
    }
    case 'trace': need(1); {
      const M = vals[0];
      if (!isMat(M) || M.n !== M.m) throw new CalcError('type', 'trace: 정방행렬이 필요합니다');
      return M.rows.reduce((s, r, i) => K.add(s, r[i]), C(0));
    }
    case 'eye': need(1); return Matrix.identity(asInt(vals[0], 'eye'));
    default: throw new CalcError('parse', `알 수 없는 함수 ${name}`);
  }
}

function boundName(args, name) {
  if (!args[1] || args[1].k !== 'id') throw new CalcError('parse', `${name}(식, 변수, ...): 두 번째 인자는 변수 이름이어야 합니다`);
  return args[1].name;
}

function reduceLoop(name, args, ctx) {
  if (args.length !== 4) throw new CalcError('arity', `${name}(식, 변수, 시작, 끝)`);
  const v = boundName(args, name);
  const a = asInt(evaluate(args[2], ctx), `${name} 시작`);
  const b = asInt(evaluate(args[3], ctx), `${name} 끝`);
  if (b - a > 1e6) throw new CalcError('domain', `${name}: 항이 너무 많습니다`);
  let acc = name === 'sum' ? C(0) : C(1);
  for (let k = a; k <= b; k++) {
    const t = withVar(ctx, v, C(k), () => asScalar(evaluate(args[0], ctx), name));
    acc = name === 'sum' ? K.add(acc, t) : K.mul(acc, t);
  }
  return acc;
}

function integral(args, ctx) {
  if (args.length !== 4) {
    throw new CalcError('unsupported', 'int(식, 변수, 하한, 상한) 형태의 정적분만 지원합니다 (부정적분은 지원하지 않음)');
  }
  const v = boundName(args, 'int');
  const a = asReal(evaluate(args[2], ctx), '적분 하한');
  const b = asReal(evaluate(args[3], ctx), '적분 상한');
  const f = (t) => withVar(ctx, v, C(t), () => asScalar(evaluate(args[0], ctx), 'int'));
  return integrate(f, a, b);
}

function diffCall(args, ctx) {
  if (args.length < 2 || args.length > 3) throw new CalcError('arity', 'diff(식, 변수, 값) 또는 변수 값이 정해진 diff(식, 변수)');
  const v = boundName(args, 'diff');
  let x0;
  if (args.length === 3) x0 = asReal(evaluate(args[2], ctx), '미분 지점');
  else if (ctx.env.has(v)) x0 = asReal(ctx.env.get(v), '미분 지점');
  else throw new CalcError('unsupported', `diff: ${v} 의 값이 필요합니다 (diff(식, ${v}, 값) 형태로 입력, 기호 미분은 지원하지 않음)`);
  const f = (t) => withVar(ctx, v, C(t), () => asScalar(evaluate(args[0], ctx), 'diff'));
  return derivative(f, x0);
}
