// 결과 표시: 직교형/극형식, 공학 표기(SI 접두어), 행렬.

import { Complex } from './complex.js';
import { Matrix, isMat } from './evaluator.js';

const PREFIX_BY_EXP = { '-15': 'f', '-12': 'p', '-9': 'n', '-6': 'μ', '-3': 'm', '0': '', '3': 'k', '6': 'M', '9': 'G', '12': 'T' };

function clean(x) {
  // 부동소수 잡음 제거 (0.30000000000000004 → 0.3)
  if (!Number.isFinite(x)) return x;
  return Number(x.toPrecision(13));
}

function trimZeros(s) {
  if (s.includes('e')) {
    let [m, e] = s.split('e');
    if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
    return `${m}e${e}`;
  }
  if (s.includes('.')) return s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function formatReal(x, { digits = 6, eng = false } = {}) {
  if (!Number.isFinite(x)) return String(x);
  x = clean(x);
  if (x === 0) return '0';
  const sign = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (eng) {
    let exp = Math.floor(Math.log10(a));
    let e3 = Math.floor(exp / 3) * 3;
    let mant = a / Math.pow(10, e3);
    let ms = trimZeros(Number(mant.toPrecision(digits)).toString());
    // 반올림으로 1000이 된 경우 보정
    if (Number(ms) >= 1000) { e3 += 3; mant = a / Math.pow(10, e3); ms = trimZeros(Number(mant.toPrecision(digits)).toString()); }
    const p = PREFIX_BY_EXP[String(e3)];
    if (p !== undefined) return `${sign}${ms}${p}`;
    return `${sign}${ms}e${e3}`;
  }
  if (a >= 1e9 || a < 1e-4) {
    let s = a.toExponential(digits - 1);
    let [m, e] = s.split('e');
    m = trimZeros(m);
    return `${sign}${m}e${Number(e)}`;
  }
  const s = a.toPrecision(digits);
  if (s.includes('e')) return `${sign}${trimZeros(Number(s).toString())}`;
  return `${sign}${trimZeros(s)}`;
}

function snapPart(v, ref) {
  return Math.abs(v) < 1e-12 * Math.max(ref, 1e-300) ? 0 : v;
}

// Complex → {rect, polar, isReal}
export function formatComplex(z, opts = {}) {
  const { angleMode = 'deg' } = opts;
  const m = z.abs;
  const re = snapPart(z.re, m);
  const im = snapPart(z.im, m);
  if (im === 0) {
    const t = formatReal(re, opts);
    return { rect: t, polar: t, isReal: true, text: t };
  }
  const sign = im < 0 ? '-' : '+';
  const reS = re === 0 ? '' : formatReal(re, opts);
  const imS = formatReal(Math.abs(im), opts);
  const rect = re === 0 ? `${im < 0 ? '-' : ''}j${imS}` : `${reS} ${sign} j${imS}`;
  const angle = angleMode === 'deg' ? (z.arg * 180) / Math.PI : z.arg;
  const unit = angleMode === 'deg' ? '°' : ' rad';
  const polar = `${formatReal(m, opts)}∠${formatReal(angle, { ...opts, eng: false })}${unit}`;
  return { rect, polar, isReal: false, text: rect };
}

// 값(Complex | Matrix) → 표시 문자열 묶음
export function formatValue(v, opts = {}) {
  if (isMat(v)) {
    const rows = v.rows.map((r) => r.map((x) => formatComplex(x, opts).rect));
    const text = '[' + rows.map((r) => r.join(', ')).join('; ') + ']';
    return { type: 'matrix', rows, rect: text, polar: text, text, isReal: true };
  }
  if (!(v instanceof Complex)) return { type: 'other', rect: String(v), polar: String(v), text: String(v), isReal: true };
  return { type: 'scalar', ...formatComplex(v, opts) };
}

export { Matrix };
