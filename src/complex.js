// 복소수 값 타입과 기본 연산. 외부 의존성 없음.

export class Complex {
  constructor(re = 0, im = 0) {
    this.re = re;
    this.im = im;
  }
  static from(x) {
    if (x instanceof Complex) return x;
    return new Complex(x, 0);
  }
  static polar(r, theta) {
    return new Complex(r * Math.cos(theta), r * Math.sin(theta));
  }
  get abs() {
    return Math.hypot(this.re, this.im);
  }
  get arg() {
    return Math.atan2(this.im, this.re);
  }
  isReal(tol = 1e-12) {
    return Math.abs(this.im) <= tol * Math.max(1, Math.abs(this.re));
  }
  isFiniteNum() {
    return Number.isFinite(this.re) && Number.isFinite(this.im);
  }
}

export const C = (re, im = 0) => new Complex(re, im);
export const J = new Complex(0, 1);

export const add = (a, b) => new Complex(a.re + b.re, a.im + b.im);
export const sub = (a, b) => new Complex(a.re - b.re, a.im - b.im);
// -0 이 생기지 않도록 0 - x 로 부호를 바꾼다 (arg(-1) = -π 방지)
export const neg = (a) => new Complex(0 - a.re, 0 - a.im);
export const conj = (a) => new Complex(a.re, 0 - a.im);
export const mul = (a, b) =>
  new Complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const scale = (a, k) => new Complex(a.re * k, a.im * k);

export function div(a, b) {
  if (b.re === 0 && b.im === 0) throw new CalcError('div0', '0으로 나눌 수 없습니다');
  // Smith's algorithm: 오버플로 방지
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re;
    const d = b.re + b.im * r;
    return new Complex((a.re + a.im * r) / d, (a.im - a.re * r) / d);
  }
  const r = b.re / b.im;
  const d = b.re * r + b.im;
  return new Complex((a.re * r + a.im) / d, (a.im * r - a.re) / d);
}

export const exp = (a) => {
  const e = Math.exp(a.re);
  return new Complex(e * Math.cos(a.im), e * Math.sin(a.im));
};

export function ln(a) {
  if (a.re === 0 && a.im === 0) throw new CalcError('domain', 'ln(0)은 정의되지 않습니다');
  return new Complex(Math.log(a.abs), a.arg);
}

export function pow(a, b) {
  // 정수 지수는 반복 곱으로 정확하게 계산
  if (b.im === 0 && Number.isInteger(b.re) && Math.abs(b.re) <= 1024) {
    let n = Math.abs(b.re);
    let result = C(1);
    let base = a;
    while (n > 0) {
      if (n & 1) result = mul(result, base);
      base = mul(base, base);
      n >>= 1;
    }
    return b.re < 0 ? div(C(1), result) : result;
  }
  if (a.re === 0 && a.im === 0) {
    if (b.re > 0) return C(0);
    throw new CalcError('domain', '0의 0 이하 거듭제곱은 정의되지 않습니다');
  }
  return exp(mul(b, ln(a)));
}

export function sqrt(a) {
  if (a.im === 0) {
    return a.re >= 0 ? C(Math.sqrt(a.re)) : C(0, Math.sqrt(-a.re));
  }
  const r = a.abs;
  const re = Math.sqrt((r + a.re) / 2);
  const im = Math.sign(a.im) * Math.sqrt((r - a.re) / 2);
  return new Complex(re, im);
}

export const sin = (a) =>
  new Complex(Math.sin(a.re) * Math.cosh(a.im), Math.cos(a.re) * Math.sinh(a.im));
export const cos = (a) =>
  new Complex(Math.cos(a.re) * Math.cosh(a.im), -Math.sin(a.re) * Math.sinh(a.im));
export const tan = (a) => div(sin(a), cos(a));
export const sinh = (a) =>
  new Complex(Math.sinh(a.re) * Math.cos(a.im), Math.cosh(a.re) * Math.sin(a.im));
export const cosh = (a) =>
  new Complex(Math.cosh(a.re) * Math.cos(a.im), Math.sinh(a.re) * Math.sin(a.im));
export const tanh = (a) => div(sinh(a), cosh(a));

// asin(z) = -j ln(jz + sqrt(1 - z^2))
export function asin(a) {
  if (a.im === 0 && Math.abs(a.re) <= 1) return C(Math.asin(a.re));
  const w = ln(add(mul(J, a), sqrt(sub(C(1), mul(a, a)))));
  return mul(C(0, -1), w);
}
export function acos(a) {
  if (a.im === 0 && Math.abs(a.re) <= 1) return C(Math.acos(a.re));
  return sub(C(Math.PI / 2), asin(a));
}
export function atan(a) {
  if (a.im === 0) return C(Math.atan(a.re));
  // atan(z) = (j/2) ln((j + z)/(j - z))
  const q = div(add(J, a), sub(J, a));
  return mul(C(0, 0.5), ln(q));
}

export class CalcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
