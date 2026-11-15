// 방정식 풀이: 선형(복소 포함)은 정확히, 비선형은 뉴턴법 다중 시작으로 푼다.

import * as K from './complex.js';
import { C, CalcError } from './complex.js';
import { evaluate, isMat, solveLinear, matMul, Matrix, inv } from './evaluator.js';

function residuals(eqs, ctx, names, xs) {
  const env = new Map(ctx.env);
  names.forEach((n, i) => env.set(n, xs[i]));
  const sub = { ...ctx, env };
  return eqs.map((e) => {
    const l = evaluate(e.a, sub);
    const r = evaluate(e.b, sub);
    if (isMat(l) || isMat(r)) throw new CalcError('type', '행렬이 들어간 방정식은 풀 수 없습니다');
    return K.sub(l, r);
  });
}

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x.abs * x.abs, 0));

function tryLinear(eqs, ctx, names) {
  const n = names.length;
  let b0;
  try {
    b0 = residuals(eqs, ctx, names, names.map(() => C(0)));
  } catch { return null; }
  const A = eqs.map(() => new Array(n));
  try {
    for (let k = 0; k < n; k++) {
      const xs = names.map((_, i) => C(i === k ? 1 : 0));
      const rk = residuals(eqs, ctx, names, xs);
      rk.forEach((v, i) => { A[i][k] = K.sub(v, b0[i]); });
    }
    // 선형성 검증: 임의의 두 점에서 A z + b0 == res(z)
    const probes = [
      names.map((_, i) => C(1.37 + 0.41 * i, 0.23 - 0.11 * i)),
      names.map((_, i) => C(-2.11 + 0.17 * i, -0.89 + 0.31 * i)),
    ];
    for (const z of probes) {
      const rz = residuals(eqs, ctx, names, z);
      for (let i = 0; i < eqs.length; i++) {
        let pred = b0[i];
        for (let k = 0; k < n; k++) pred = K.add(pred, K.mul(A[i][k], z[k]));
        const tol = 1e-8 * Math.max(1, rz[i].abs, pred.abs);
        if (K.sub(rz[i], pred).abs > tol) return null;
      }
    }
  } catch { return null; }
  return { A, b: b0.map((v) => K.neg(v)) };
}

function jacobian(eqs, ctx, names, x, r0) {
  const n = names.length;
  const J = eqs.map(() => new Array(n));
  for (let k = 0; k < n; k++) {
    const h = 1e-7 * Math.max(1, x[k].abs);
    const xp = x.map((v, i) => (i === k ? K.add(v, C(h)) : v));
    const xm = x.map((v, i) => (i === k ? K.sub(v, C(h)) : v));
    const rp = residuals(eqs, ctx, names, xp);
    const rm = residuals(eqs, ctx, names, xm);
    for (let i = 0; i < eqs.length; i++) J[i][k] = K.scale(K.sub(rp[i], rm[i]), 1 / (2 * h));
  }
  return J;
}

// 식의 항 크기(수렴 판정의 기준): 각 방정식의 |좌변|+|우변| 의 최댓값
function termScale(eqs, ctx, names, xs) {
  const env = new Map(ctx.env);
  names.forEach((n, i) => env.set(n, xs[i]));
  const sub = { ...ctx, env };
  let m = 0;
  for (const e of eqs) {
    const l = evaluate(e.a, sub);
    const r = evaluate(e.b, sub);
    m = Math.max(m, l.abs + r.abs);
  }
  return Math.max(m, 1e-300);
}

function newton(eqs, ctx, names, x0) {
  let x = x0;
  let r;
  try { r = residuals(eqs, ctx, names, x); } catch { return null; }
  let rn = norm(r);
  for (let it = 0; it < 200; it++) {
    if (!Number.isFinite(rn)) return null;
    if (rn === 0) break;
    let J;
    try { J = jacobian(eqs, ctx, names, x, r); } catch { return null; }
    const sol = solveLinear(J, r.map(K.neg));
    if (!sol.x) return null;
    const stepNorm = norm(sol.x);
    const xNorm = norm(x);
    let t = 1;
    let accepted = false;
    for (let b = 0; b < 40; b++) {
      const xn = x.map((v, i) => K.add(v, K.scale(sol.x[i], t)));
      let rnew;
      try { rnew = residuals(eqs, ctx, names, xn); } catch { t /= 2; continue; }
      const nn = norm(rnew);
      if (Number.isFinite(nn) && nn < rn) { x = xn; r = rnew; rn = nn; accepted = true; break; }
      t /= 2;
    }
    if (!accepted) break; // 잡음 한계에 도달: 아래 판정으로
    if (stepNorm * t < 1e-14 * (1 + xNorm)) break;
  }
  let scale;
  try { scale = termScale(eqs, ctx, names, x); } catch { return null; }
  return rn <= 1e-9 * scale ? x : null;
}

function cleanRoot(x) {
  return x.map((v) => {
    const m = v.abs;
    const re = Math.abs(v.re) < 1e-10 * Math.max(1, m) ? 0 : v.re;
    const im = Math.abs(v.im) < 1e-10 * Math.max(1, m) ? 0 : v.im;
    return C(re, im);
  });
}

function distinct(list, x) {
  return !list.some((y) => y.every((v, i) => K.sub(v, x[i]).abs < 1e-6 * (1 + v.abs)));
}

// eqs: [{a, b}] AST, names: 미지수 이름들, guess: Complex[] (선택)
export function solveEquations(eqs, ctx, names, guess) {
  const n = names.length;
  const m = eqs.length;
  if (n === 0) throw new CalcError('nounknown', '미지수가 없습니다 (모든 변수에 값이 있음)');
  const warnings = [];

  const lin = tryLinear(eqs, ctx, names);
  if (lin) {
    const sol = solveLinear(lin.A, lin.b);
    if (sol.inconsistent) throw new CalcError('overdetermined', `과결정: 방정식 ${m}개가 서로 충돌합니다 (미지수 ${n}개: ${names.join(', ')})`);
    if (sol.singular) {
      throw new CalcError('underdetermined', `부정: 독립 방정식이 ${sol.rank}개뿐이라 미지수 ${n}개(${names.join(', ')})를 모두 정할 수 없습니다`);
    }
    if (m > n) warnings.push(`방정식 ${m}개가 미지수 ${n}개보다 많지만 서로 일치합니다`);
    return { names, solutions: [cleanRoot(sol.x)], method: 'linear', warnings };
  }

  if (m !== n) {
    throw new CalcError(m > n ? 'overdetermined' : 'underdetermined',
      `비선형: 방정식 수(${m})와 미지수 수(${n})가 같아야 풉니다 (미지수: ${names.join(', ')})`);
  }

  const roots = [];
  const starts = [];
  if (guess && guess.length) starts.push(names.map((_, i) => guess[Math.min(i, guess.length - 1)]));
  if (n === 1) {
    for (const t of [1, -1, 0.5, -0.5, 2, -2, 5, -5, 10, -10, 0.1, -0.1, 100, -100, 1e3, -1e3, 1e-3]) starts.push([C(t)]);
    for (const r of [1, 3, 30]) for (let k = 0; k < 8; k++) starts.push([K.mul(C(r), K.exp(C(0, (Math.PI * k) / 4 + 0.3)))]);
  } else {
    for (const t of [1, -1, 0.5, 2, -2, 10, 0.1, 5, -5, 100]) {
      starts.push(names.map((_, i) => C(t * (1 + 0.37 * i))));
      starts.push(names.map((_, i) => C(t * (i % 2 ? -1 : 1) * (1 + 0.21 * i))));
    }
  }
  for (const s of starts) {
    const r = newton(eqs, ctx, names, s);
    if (r) {
      const c = cleanRoot(r);
      if (distinct(roots, c)) roots.push(c);
      if (n > 1 && roots.length >= 1) break;
      if (roots.length >= 8) break;
    }
  }
  if (!roots.length) throw new CalcError('noconverge', '해를 찾지 못했습니다. 초기값을 지정해 보세요: solve(식, 변수, 초기값)');
  roots.sort((p, q) => {
    const pr = p.every((v) => v.im === 0), qr = q.every((v) => v.im === 0);
    if (pr !== qr) return pr ? -1 : 1;
    return p[0].re - q[0].re;
  });
  if (n > 1) warnings.push('비선형 연립식: 수렴한 해 하나만 표시합니다. 다른 해는 초기값을 지정하세요');
  else if (roots.length > 1) warnings.push(`해 ${roots.length}개를 찾았습니다`);
  else warnings.push('비선형: 다른 해가 더 있을 수 있습니다');
  return { names, solutions: roots, method: 'newton', warnings };
}

export { matMul, Matrix, inv };
