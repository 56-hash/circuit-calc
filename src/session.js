// 계산 세션: 직렬(Step)과 일괄(Batch) 실행. 설계 명세서 6장.

import { C, Complex, CalcError } from './complex.js';
import {
  parseExpression, splitEquation, splitStatements, freeIdentifiers, CONSTANTS, FUNCTIONS,
} from './parser.js';
import { evaluate, createContext, isMat } from './evaluator.js';
import { solveEquations } from './solve.js';
import { formatValue } from './format.js';

function hasId(ast, name) {
  switch (ast.k) {
    case 'id': return ast.name === name;
    case 'num': return false;
    case 'bin': case 'polar': case 'eq': return hasId(ast.a, name) || hasId(ast.b, name);
    case 'un': case 'fact': case 'paren': return hasId(ast.a, name);
    case 'call': return ast.args.some((a) => hasId(a, name));
    case 'mat': return ast.rows.some((r) => r.some((a) => hasId(a, name)));
    default: return false;
  }
}

export class CalcSession {
  constructor(opts = {}) {
    this.angleMode = opts.angleMode ?? 'deg';
    this.fmt = { digits: opts.digits ?? 6, eng: opts.eng ?? false };
    this.reset();
  }

  reset() {
    this.env = new Map();
    this.ans = null;
    this.results = new Map(); // 줄 번호 → 값
  }

  setAngleMode(mode) { this.angleMode = mode === 'rad' ? 'rad' : 'deg'; }

  ctx() {
    return createContext({ env: this.env, angleMode: this.angleMode, ans: this.ans, results: this.results });
  }

  known() { return new Set(this.env.keys()); }

  display(v) {
    return formatValue(v, { ...this.fmt, angleMode: this.angleMode });
  }

  // ---- 분석 ----
  analyze(text) {
    const notes = [];
    const parts = splitEquation(text);
    if (!parts) {
      const { ast, notes: n } = parseExpression(text, { knownVars: this.known() });
      notes.push(...n);
      if (ast.k === 'call' && ast.name === 'solve') return { type: 'solve', ast, notes };
      return { type: 'expr', ast, notes };
    }
    // 두 번째 '=' 가 최상위에 또 있으면 오류
    if (splitEquation(parts[1])) throw new CalcError('parse', "한 줄에 '='는 한 번만 사용할 수 있습니다");
    const known = this.known();
    const attempt = (bare) => {
      const l = parseExpression(parts[0], { knownVars: known, bareUnits: bare });
      const r = parseExpression(parts[1], { knownVars: known, bareUnits: bare });
      const ids = new Set([...freeIdentifiers(l.ast), ...freeIdentifiers(r.ast)]);
      for (const k of known) ids.delete(k);
      return { l, r, unknowns: [...ids] };
    };
    let a = attempt(true);
    if (a.unknowns.length === 0) {
      const b = attempt(false);
      if (b.unknowns.length > 0) a = b; // V, A 같은 기호를 단위가 아니라 변수로 해석
    }
    notes.push(...a.l.notes, ...a.r.notes);
    const lhsIsId = a.l.ast.k === 'id' && !CONSTANTS.has(a.l.ast.name) && !FUNCTIONS.has(a.l.ast.name)
      && !a.l.ast.name.startsWith('#');
    const lhsName = lhsIsId ? a.l.ast.name : null;
    let unknowns = a.unknowns;
    if (lhsName && unknowns.includes(lhsName)) {
      // 좌변이 아직 없는 단일 변수이고 우변에 미지수가 없으면 '대입'으로 본다 (R = 4.7k)
      const rhsFree = [...freeIdentifiers(a.r.ast)].filter((id) => !known.has(id));
      if (rhsFree.length === 0) unknowns = [];
    }
    return { type: 'eqn', lhs: a.l.ast, rhs: a.r.ast, unknowns, lhsName, notes };
  }

  // ---- 직렬(Step): 한 줄 실행 ----
  runLine(no, text) {
    const parts = [];
    let stmts;
    try { stmts = splitStatements(text); } catch (e) { stmts = [text]; }
    if (stmts.length === 0) return { no, text, ok: true, parts: [{ kind: 'empty', ok: true, notes: [] }], last: null };
    for (const s of stmts) {
      const part = this.runStatement(s);
      parts.push(part);
      if (!part.ok) break;
    }
    const lastOk = [...parts].reverse().find((p) => p.ok && p.value !== undefined);
    if (lastOk) {
      this.ans = lastOk.value;
      this.results.set(no, lastOk.value);
    }
    return { no, text, ok: parts.every((p) => p.ok), parts, last: lastOk ?? parts[parts.length - 1] };
  }

  runStatement(text) {
    const part = { text, ok: false, notes: [], warnings: [] };
    try {
      const an = this.analyze(text);
      part.notes = an.notes;
      if (an.type === 'expr') {
        part.kind = 'expr';
        part.value = evaluate(an.ast, this.ctx());
        part.display = this.display(part.value);
      } else if (an.type === 'solve') {
        Object.assign(part, this.runSolveCall(an.ast));
      } else if (an.lhsName && an.unknowns.length === 0) {
        part.kind = 'assign';
        part.name = an.lhsName;
        part.value = evaluate(an.rhs, this.ctx());
        this.env.set(an.lhsName, part.value);
        part.display = this.display(part.value);
      } else if (an.unknowns.length === 0) {
        Object.assign(part, this.checkEquation(an));
      } else {
        if (an.unknowns.length > 1) {
          throw new CalcError('multi', `미지수가 ${an.unknowns.length}개(${an.unknowns.join(', ')})입니다. 연립식은 일괄 모드에서 한꺼번에 풀어 주세요`);
        }
        Object.assign(part, this.solveSystem([{ a: an.lhs, b: an.rhs }], an.unknowns));
      }
      part.ok = true;
    } catch (e) {
      part.ok = false;
      part.error = e.message;
      part.code = e.code ?? 'error';
      if (e.varName) part.varName = e.varName;
    }
    return part;
  }

  checkEquation(an) {
    const l = evaluate(an.lhs, this.ctx());
    const r = evaluate(an.rhs, this.ctx());
    const dl = this.display(l);
    const dr = this.display(r);
    let holds;
    if (isMat(l) || isMat(r)) holds = dl.text === dr.text;
    else holds = Math.hypot(l.re - r.re, l.im - r.im) <= 1e-9 * Math.max(1, l.abs, r.abs);
    return { kind: 'check', holds, lhs: dl, rhs: dr, display: { text: holds ? '성립 (참)' : `불성립 (좌변 ${dl.text}, 우변 ${dr.text})`, rect: '', polar: '' } };
  }

  // 방정식 묶음을 풀어 환경에 첫 해를 등록
  solveSystem(eqs, unknowns, guess) {
    const res = solveEquations(eqs, this.ctx(), unknowns, guess);
    const solutions = res.solutions.map((sol) => unknowns.map((n, i) => ({ name: n, value: sol[i], display: this.display(sol[i]) })));
    unknowns.forEach((n, i) => this.env.set(n, res.solutions[0][i]));
    return { kind: 'equation', names: unknowns, solutions, method: res.method, warnings: res.warnings,
      display: { text: solutions.map((s) => s.map((x) => `${x.name} = ${x.display.text}`).join(', ')).join('  /  ') } };
  }

  runSolveCall(ast) {
    const eqs = [];
    const names = [];
    const guess = [];
    for (const a of ast.args) {
      if (a.k === 'eq') eqs.push({ a: a.a, b: a.b });
      else if (a.k === 'id') names.push(a.name);
      else if (a.k === 'num' || a.k === 'un' || a.k === 'paren') guess.push(evaluate(a, this.ctx()));
      else eqs.push({ a, b: { k: 'num', v: C(0) } }); // solve(f(x), x): f(x)=0
    }
    if (!eqs.length) throw new CalcError('parse', 'solve(방정식, ..., 변수, ..., 초기값) 형태로 입력하세요');
    let unknowns = names;
    if (!unknowns.length) {
      const ids = new Set();
      eqs.forEach((e) => { freeIdentifiers(e.a, new Set(), ids); freeIdentifiers(e.b, new Set(), ids); });
      for (const k of this.env.keys()) ids.delete(k);
      unknowns = [...ids];
    }
    // 이름이 지정된 변수가 env에 이미 있으면 미지수로 취급하기 위해 잠시 제거
    const saved = new Map();
    for (const n of unknowns) if (this.env.has(n)) { saved.set(n, this.env.get(n)); this.env.delete(n); }
    try {
      return { ...this.solveSystem(eqs, unknowns, guess.length ? guess : undefined), kind: 'solve' };
    } catch (e) {
      for (const [n, v] of saved) this.env.set(n, v);
      throw e;
    }
  }

  // ---- 일괄(Batch) ----
  // lines: [{no, text}]. 모든 대입을 먼저 수집한 뒤 연립식을 풀고 마지막에 식을 계산한다.
  runBatch(lines) {
    const out = lines.map((l) => ({ no: l.no, text: l.text, ok: true, parts: [], last: null }));
    const stmts = [];
    lines.forEach((l, li) => {
      let list;
      try { list = splitStatements(l.text); } catch { list = [l.text]; }
      list.forEach((text, si) => stmts.push({ li, si, text, part: { text, ok: false, notes: [], warnings: [] }, done: false }));
    });
    const fail = (s, e) => {
      s.part.ok = false; s.part.error = e.message; s.part.code = e.code ?? 'error'; s.done = true;
    };
    const savedAns = this.ans;
    this.ans = null;

    // 분석
    for (const s of stmts) {
      try {
        s.an = this.analyze(s.text);
        s.part.notes = s.an.notes;
        const asts = s.an.type === 'eqn' ? [s.an.lhs, s.an.rhs] : [s.an.ast];
        if (asts.some((a) => hasId(a, 'Ans'))) throw new CalcError('batch-ans', '일괄 모드에서는 Ans를 쓸 수 없습니다 (순서에 의존하므로). #줄번호를 사용하세요');
      } catch (e) { fail(s, e); }
    }

    // A) 대입 수집: 우변이 계산 가능한 `이름 = 식` 을 의존 순서로 등록
    const assigned = new Set();
    const pending = new Set(stmts.filter((s) => !s.done && s.an.type === 'eqn' && s.an.lhsName));
    let progress = true;
    while (progress && pending.size) {
      progress = false;
      const pendingNames = new Set([...pending].map((s) => s.an.lhsName));
      for (const s of [...pending]) {
        const L = s.an.lhsName;
        const waiting = [...freeIdentifiers(s.an.rhs)].some((id) => !this.env.has(id) || (id !== L && pendingNames.has(id)));
        if (waiting) continue;
        pending.delete(s);
        progress = true;
        if (assigned.has(L)) { fail(s, new CalcError('dup', `${L} 이(가) 이미 대입되었습니다`)); continue; }
        try {
          const v = evaluate(s.an.rhs, this.ctx());
          this.env.set(L, v);
          assigned.add(L);
          s.part.kind = 'assign'; s.part.name = L; s.part.value = v; s.part.display = this.display(v); s.part.ok = true; s.done = true;
        } catch (e) { fail(s, e); }
        break; // pendingNames 갱신을 위해 한 건 처리 후 다시 계산
      }
    }

    // B) 연립 방정식
    const eqStmts = stmts.filter((s) => !s.done && s.an.type === 'eqn');
    const toSolve = [];
    for (const s of eqStmts) {
      const ids = new Set([...freeIdentifiers(s.an.lhs), ...freeIdentifiers(s.an.rhs)]);
      for (const k of this.env.keys()) ids.delete(k);
      if (ids.size === 0) {
        try {
          Object.assign(s.part, this.checkEquation(s.an)); s.part.ok = true; s.done = true;
        } catch (e) { fail(s, e); }
      } else toSolve.push(s);
    }
    if (toSolve.length) {
      const ids = new Set();
      toSolve.forEach((s) => {
        freeIdentifiers(s.an.lhs, new Set(), ids); freeIdentifiers(s.an.rhs, new Set(), ids);
      });
      for (const k of this.env.keys()) ids.delete(k);
      const unknowns = [...ids];
      try {
        const sys = this.solveSystem(toSolve.map((s) => ({ a: s.an.lhs, b: s.an.rhs })), unknowns);
        toSolve.forEach((s) => {
          s.part.ok = true; s.done = true;
          Object.assign(s.part, sys);
          s.part.system = { equations: toSolve.length, unknowns };
        });
      } catch (e) { toSolve.forEach((s) => fail(s, e)); }
    }

    // C) solve() 와 D) 식 계산 (줄 순서대로)
    for (const s of stmts) {
      if (s.done) continue;
      try {
        if (s.an.type === 'solve') Object.assign(s.part, this.runSolveCall(s.an.ast));
        else if (s.an.type === 'expr') {
          s.part.kind = 'expr';
          s.part.value = evaluate(s.an.ast, this.ctx());
          s.part.display = this.display(s.part.value);
        }
        s.part.ok = true; s.done = true;
        if (s.part.value !== undefined) this.results.set(lines[s.li].no, s.part.value);
      } catch (e) { fail(s, e); }
    }
    for (const s of stmts) {
      if (s.part.value !== undefined && s.part.kind === 'assign') this.results.set(lines[s.li].no, s.part.value);
    }

    this.ans = savedAns;
    for (const s of stmts) {
      out[s.li].parts[s.si] = s.part;
    }
    out.forEach((o) => {
      o.ok = o.parts.every((p) => p.ok);
      o.last = [...o.parts].reverse().find((p) => p.ok) ?? o.parts[o.parts.length - 1] ?? null;
    });
    return out;
  }
}

export { Complex };
