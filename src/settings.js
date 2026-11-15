// 설정 기본값과 정규화 (DOM 에 의존하지 않음)
export const DEFAULTS = {
  provider: 'anthropic', // 'anthropic' | 'mock'
  apiKey: '',
  model: 'claude-sonnet-5-5',
  timeoutSec: 30,
  mode: 'step', // 'step' | 'batch'
  angleMode: 'deg', // 'deg' | 'rad'
  outFmt: 'both', // 'rect' | 'polar' | 'both'
  eng: false,
  digits: 6,
  keepEnv: false,
  retentionDays: 30,
  autoRun: false, // 인식 직후 자동 실행
};

const clamp = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);

export function normalizeSettings(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  return {
    provider: pick(s.provider, ['anthropic', 'mock'], DEFAULTS.provider),
    apiKey: String(s.apiKey ?? '').trim(),
    model: String(s.model || DEFAULTS.model).trim(),
    timeoutSec: clamp(s.timeoutSec, 5, 120, DEFAULTS.timeoutSec),
    mode: pick(s.mode, ['step', 'batch'], DEFAULTS.mode),
    angleMode: pick(s.angleMode, ['deg', 'rad'], DEFAULTS.angleMode),
    outFmt: pick(s.outFmt, ['rect', 'polar', 'both'], DEFAULTS.outFmt),
    eng: !!s.eng,
    digits: clamp(s.digits, 3, 12, DEFAULTS.digits),
    keepEnv: !!s.keepEnv,
    retentionDays: clamp(s.retentionDays, 1, 365, DEFAULTS.retentionDays),
    autoRun: !!s.autoRun,
  };
}
