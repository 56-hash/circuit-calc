// 계산 문법 파서: 정규화 → 토큰화 → AST.
// 문법 요약은 설계 명세서 5장을 따른다.

import { Complex, C, CalcError } from './complex.js';

export const SI_PREFIX = { T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
const LONE_PREFIX = new Set(['T', 'G', 'M', 'k', 'K', 'm', 'u', 'n', 'p']);
const UNITS = new Set(['ohm', 'V', 'A', 'F', 'H', 'Hz', 'W', 's']);
// 접두어 없이 단독으로도 단위로 취급하는 것 ('s'는 변수와 혼동되므로 제외)
const BARE_UNITS = new Set(['ohm', 'V', 'A', 'F', 'H', 'Hz', 'W']);

export const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'exp', 'ln', 'log', 'log2', 'log10', 'sqrt', 'cbrt', 'abs', 'arg', 're', 'im', 'conj',
  'floor', 'ceil', 'round', 'trunc', 'sign', 'min', 'max', 'mod', 'pow', 'root',
  'dB', 'dBp', 'rect', 'polar', 'par', 'deg', 'rad',
  'inv', 'det', 'transpose', 'trace', 'eye',
  'diff', 'int', 'sum', 'prod', 'solve', 'gcd', 'lcm',
]);
export const CONSTANTS = new Set(['pi', 'e', 'j', 'Ans']);

const GREEK = {
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta',
  'θ': 'theta', 'λ': 'lambda', 'ν': 'nu', 'ξ': 'xi', 'ρ': 'rho', 'σ': 'sigma',
  'τ': 'tau', 'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Δ': 'Delta', 'Σ': 'Sigma', 'Φ': 'Phi', 'Ψ': 'Psi',
};
const SUB = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

// 유니코드와 필기 표기를 계산 문법으로 정규화한다.
export function normalize(src) {
  let s = String(src).normalize('NFC');
  s = s.replace(/[−–—－]/g, '-');
  s = s.replace(/[×·⋅∗•]/g, '*');
  s = s.replace(/[÷∕]/g, '/');
  s = s.replace(/∠/g, '@'); // ∠
  s = s.replace(/[∥‖]/g, '||'); // ∥ ‖
  s = s.replace(/[μµ]/g, 'u'); // μ µ
  s = s.replace(/[ΩΩ]/g, 'ohm'); // Ω
  s = s.replace(/[°˚]/g, 'deg'); // ° ˚
  s = s.replace(/π/g, 'pi');
  s = s.replace(/[（]/g, '(').replace(/[）]/g, ')');
  s = s.replace(/[＋]/g, '+').replace(/[＝]/g, '=');
  s = s.replace(/\*\*/g, '^');
  s = s.replace(/√\s*\(/g, 'sqrt(').replace(/√\s*([0-9A-Za-z_.]+)/g, 'sqrt($1)');
  s = s.replace(/[₀-₉]+/g, (m) => '_' + [...m].map((c) => SUB[c]).join(''));
  s = s.replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => '^(' + [...m].map((c) => SUP[c]).join('') + ')');
  s = s.replace(/[α-ωΑ-Ωϕ]/g, (c) => GREEK[c] ?? c);
  s = s.replace(/_\{([^}]*)\}/g, '_$1'); // V_{1} → V_1
  s = s.replace(/\\(?:left|right)/g, '');
  return s;
}

function canonName(name) {
  return name.replace(/_/g, '');
}

// 토큰화. opts.knownVars: 값이 있는 변수 이름 집합, opts.bareUnits: 단독 단위 기호 허용
export function tokenize(src, opts = {}) {
  const known = opts.knownVars ?? new Set();
  const bareUnits = opts.bareUnits !== false;
  const notes = [];
  const s = normalize(src);
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    // 숫자
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
      let text = m[0];
      let value = Number(text);
      i += text.length;
      const tok = { t: 'num', v: value, angle: false, text };
      // 숫자 바로 뒤(공백 1개 허용)의 식별자: 접두어/단위/각도 단위 판정
      let j = i;
      if (s[j] === ' ') j++;
      const idm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j));
      if (idm) {
        const word = idm[0];
        const spaced = j > i;
        const res = classifySuffix(word, known, bareUnits, spaced);
        if (res) {
          if (res.scale !== undefined) tok.v = value * res.scale;
          if (res.angle) { tok.angle = true; tok.v = res.angle === 'deg' ? (value * Math.PI) / 180 : value; }
          if (res.note) notes.push(`${text}${spaced ? ' ' : ''}${word}: ${res.note}`);
          i = j + word.length;
        }
      }
      out.push(tok);
      continue;
    }
    // 이전 줄 결과 참조 #3
    if (ch === '#' && /[0-9]/.test(s[i + 1] ?? '')) {
      const m = /^#\d+/.exec(s.slice(i));
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    // 식별자
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      // 필기 표기 j4, j2.5 → 허수 단위 j 뒤에 숫자 (값이 정해진 변수 이름이면 변수로 유지)
      if (/^j\d/.test(m[0]) && !known.has(canonName(m[0]))) {
        out.push({ t: 'id', v: 'j' });
        i += 1;
        continue;
      }
      out.push({ t: 'id', v: canonName(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '|' && s[i + 1] === '|') { out.push({ t: 'op', v: '||' }); i += 2; continue; }
    if ('+-*/^!@(),=[];%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new CalcError('parse', `해석할 수 없는 문자: '${ch}'`);
  }
  return { tokens: out, notes };
}

function classifySuffix(word, known, bareUnits, spaced) {
  if (word === 'deg') return { angle: 'deg' };
  if (word === 'rad') return { angle: 'rad' };
  if (known.has(canonName(word))) return null; // 변수 이름이면 암묵적 곱
  if (/^(meg|Meg|MEG)(ohm)?$/.test(word)) return { scale: 1e6, note: '메가(M)로 해석' };
  // 접두어 + 단위
  if (word.length >= 2 && (word[0] in SI_PREFIX) && UNITS.has(word.slice(1))) {
    return { scale: SI_PREFIX[word[0]], note: `접두어 ${word[0]}, 단위 ${word.slice(1)}` };
  }
  if (spaced) {
    // 공백이 있으면 확실한 단위 표기일 때만 소비
    if (UNITS.has(word) && word !== 's') return { scale: 1, note: `단위 ${word} 무시` };
    return null;
  }
  if (word.length === 1 && LONE_PREFIX.has(word)) return { scale: SI_PREFIX[word], note: `접두어 ${word}` };
  if (bareUnits && BARE_UNITS.has(word)) return { scale: 1, note: `단위 ${word} 무시(변수라면 * 로 분리)` };
  return null;
}

// ---- AST 파서 ----
// 노드: num, id, bin, un, call, mat, fact, polar, eq
export function parseExpression(src, opts = {}) {
  const { tokens, notes } = tokenize(src, opts);
  const p = new Parser(tokens);
  const ast = p.parseTop();
  return { ast, notes };
}

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
  }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  isOp(v) { const k = this.peek(); return k && k.t === 'op' && k.v === v; }
  expectOp(v) {
    if (!this.isOp(v)) throw new CalcError('parse', `'${v}'가 필요합니다`);
    this.i++;
  }
  parseTop() {
    if (this.t.length === 0) throw new CalcError('parse', '빈 식입니다');
    const e = this.parseAdditive();
    if (this.i < this.t.length) {
      const k = this.peek();
      throw new CalcError('parse', `예상하지 못한 '${k.v}'`);
    }
    return e;
  }
  // 함수 인자 안에서만 '=' 를 허용 (solve 용)
  parseArg() {
    const a = this.parseAdditive();
    if (this.isOp('=')) {
      this.i++;
      const b = this.parseAdditive();
      return { k: 'eq', a, b };
    }
    return a;
  }
  parseAdditive() {
    let left = this.parseTerm();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      const right = this.parseTerm();
      left = { k: 'bin', op, a: left, b: right };
    }
    return left;
  }
  startsOperand() {
    const k = this.peek();
    if (!k) return false;
    if (k.t === 'num' || k.t === 'id') return true;
    if (k.t === 'op' && k.v === '(') return true;
    return false;
  }
  parseTerm() {
    let left = this.parsePolar();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('||')) {
        const op = this.next().v;
        const right = this.parsePolar();
        left = { k: 'bin', op, a: left, b: right };
      } else if (this.startsOperand()) {
        const right = this.parsePolar();
        left = { k: 'bin', op: '*', a: left, b: right, implicit: true };
      } else break;
    }
    return left;
  }
  parsePolar() {
    let left = this.parseUnary();
    while (this.isOp('@')) {
      this.i++;
      const right = this.parseUnary();
      left = { k: 'polar', a: left, b: right };
    }
    return left;
  }
  parseUnary() {
    if (this.isOp('-')) { this.i++; return { k: 'un', op: '-', a: this.parseUnary() }; }
    if (this.isOp('+')) { this.i++; return this.parseUnary(); }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      this.i++;
      const exp = this.parseUnary(); // 우결합, 2^-3 허용
      return { k: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  }
  parsePostfix() {
    let e = this.parsePrimary();
    while (this.isOp('!')) { this.i++; e = { k: 'fact', a: e }; }
    while (this.isOp('%')) { this.i++; e = { k: 'bin', op: '/', a: e, b: { k: 'num', v: C(100) } }; }
    return e;
  }
  parsePrimary() {
    const k = this.next();
    if (!k) throw new CalcError('parse', '식이 끝났습니다. 피연산자가 필요합니다');
    if (k.t === 'num') return { k: 'num', v: C(k.v), angle: k.angle };
    if (k.t === 'id') {
      if (this.isOp('(') && (FUNCTIONS.has(k.v))) {
        this.i++;
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.parseArg());
          while (this.isOp(',')) { this.i++; args.push(this.parseArg()); }
        }
        this.expectOp(')');
        return { k: 'call', name: k.v, args };
      }
      if (FUNCTIONS.has(k.v) && !this.isOp('(')) {
        // 괄호 없는 함수 호출: sin 30deg
        const arg = this.parseUnary();
        return { k: 'call', name: k.v, args: [arg] };
      }
      return { k: 'id', name: k.v };
    }
    if (k.t === 'op' && k.v === '(') {
      const e = this.parseAdditive();
      this.expectOp(')');
      return { k: 'paren', a: e };
    }
    if (k.t === 'op' && k.v === '[') {
      return this.parseMatrix();
    }
    throw new CalcError('parse', `예상하지 못한 '${k.v}'`);
  }
  parseMatrix() {
    // 이미 '[' 소비됨. [[1,2],[3,4]] 또는 [1,2;3,4]
    const rows = [];
    if (this.isOp('[')) {
      while (this.isOp('[')) {
        this.i++;
        rows.push(this.parseRowUntil(']'));
        this.expectOp(']');
        if (this.isOp(',')) this.i++;
      }
      this.expectOp(']');
    } else {
      let row = [];
      for (;;) {
        row.push(this.parseAdditive());
        if (this.isOp(',')) { this.i++; continue; }
        if (this.isOp(';')) { this.i++; rows.push(row); row = []; continue; }
        break;
      }
      rows.push(row);
      this.expectOp(']');
    }
    const w = rows[0].length;
    if (rows.some((r) => r.length !== w)) throw new CalcError('parse', '행렬의 행 길이가 서로 다릅니다');
    return { k: 'mat', rows };
  }
  parseRowUntil(close) {
    const row = [];
    if (this.isOp(close)) return row;
    row.push(this.parseAdditive());
    while (this.isOp(',')) { this.i++; row.push(this.parseAdditive()); }
    return row;
  }
}

// 최상위 '=' 위치를 찾아 문장을 둘로 나눈다. 없으면 null.
export function splitEquation(src) {
  const s = normalize(src);
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '=' && depth === 0) {
      return [s.slice(0, i), s.slice(i + 1)];
    }
  }
  return null;
}

// 최상위 ';' 로 문장을 나눈다 (행렬 [ ... ; ... ] 내부의 ; 는 제외)
export function splitStatements(src) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of String(src)) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ';' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// AST 안의 자유 식별자(함수/상수 제외)를 모은다.
export function freeIdentifiers(ast, bound = new Set(), out = new Set()) {
  switch (ast.k) {
    case 'num': break;
    case 'id':
      if (!CONSTANTS.has(ast.name) && !ast.name.startsWith('#') && !bound.has(ast.name)) out.add(ast.name);
      break;
    case 'bin': case 'polar': case 'eq':
      freeIdentifiers(ast.a, bound, out); freeIdentifiers(ast.b, bound, out); break;
    case 'un': case 'fact': case 'paren':
      freeIdentifiers(ast.a, bound, out); break;
    case 'call': {
      if (['sum', 'prod', 'int', 'diff'].includes(ast.name) && ast.args.length >= 2 && ast.args[1].k === 'id') {
        const b2 = new Set(bound); b2.add(ast.args[1].name);
        freeIdentifiers(ast.args[0], b2, out);
        ast.args.slice(2).forEach((a) => freeIdentifiers(a, bound, out));
      } else if (ast.name === 'solve') {
        ast.args.forEach((a) => { if (a.k !== 'id') freeIdentifiers(a, bound, out); });
      } else ast.args.forEach((a) => freeIdentifiers(a, bound, out));
      break;
    }
    case 'mat': ast.rows.forEach((r) => r.forEach((a) => freeIdentifiers(a, bound, out))); break;
    default: break;
  }
  return out;
}

export function containsAngle(ast) {
  switch (ast.k) {
    case 'num': return !!ast.angle;
    case 'id': return false;
    case 'bin': case 'polar': case 'eq': return containsAngle(ast.a) || containsAngle(ast.b);
    case 'un': case 'fact': case 'paren': return containsAngle(ast.a);
    case 'call': return ast.args.some(containsAngle);
    case 'mat': return ast.rows.some((r) => r.some(containsAngle));
    default: return false;
  }
}

export { Complex };
