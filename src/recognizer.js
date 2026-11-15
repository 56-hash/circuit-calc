// 인식 모듈: 이미지 → 줄별 JSON. LLM 은 "받아 적기"만 하고 계산은 하지 않는다. (설계 명세서 4장)

import { CalcSession } from './session.js';
import { splitStatements } from './parser.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';

export class RecognitionError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export const SYSTEM_PROMPT = `You transcribe handwritten engineering math (circuit theory, electronic circuits, signals) from an image into structured JSON for a calculator app.

ABSOLUTE RULES
- Transcribe exactly what is written. NEVER solve, simplify, correct, complete, or reorder anything. Do not compute any value.
- If a character is ambiguous, write your best reading in "calc", list the alternatives in "note" (for example: "1 or l"), and lower "confidence".
- If something is unreadable, skip it and describe it in the "unreadable" array. Never guess a number.
- Ignore circuit diagrams and drawings. A text label or a value written next to a drawing may be given as kind "text".
- Output ONE JSON object and nothing else (no markdown fences, no commentary).

OUTPUT SCHEMA
{"lines":[{"id":1,"latex":"<LaTeX for display>","calc":"<calculator syntax>","kind":"expr|assign|equation|text","confidence":0.0-1.0,"note":""}],"unreadable":["..."]}
- One entry per handwritten line, from top to bottom. If one line holds several separate statements, separate them with ";" inside "calc".
- kind: "expr" a value to compute; "assign" a definition like V = 10; "equation" an equation with unknowns; "text" explanatory words that must not be computed.
- "latex" is only for display. "calc" is what the app evaluates.

CALC SYNTAX (follow exactly)
- Operators: + - * / ^ and parentheses. Write every product explicitly with "*" between variables (R1*I1). Fractions use parentheses: (a+b)/(c+d). Powers use ^: x^2, e^(-t). Square root: sqrt(x).
- Imaginary unit is j (never i): 3+j4, 3+4*j.
- Phasor (polar) form uses "@" with the angle in degrees: 10@30deg, 5@(-45deg). Always put a negative angle in parentheses. For the angle symbol written as ∠, use "@".
- Parallel combination of impedances or resistors (written ∥ or //) uses "||": R1||R2.
- SI prefixes are attached directly to the number: 4.7k, 2.2u (micro), 100n, 10m (milli), 3M (mega), 1p. Units may follow (4.7kohm, 10mH, 50Hz) but are optional. If a variable named V, A, F, H or W follows a number, put an explicit "*" (5*V).
- Variable names: letters, digits, underscore. Subscripts are written with no braces: V_1 or V1. Greek letters are spelled out: omega, theta, phi, tau, alpha, beta. Constants: pi, e, j.
- Functions: sin cos tan asin acos atan sinh cosh tanh exp ln log (base 10) sqrt abs arg conj re im dB(x). An angle written with a degree sign keeps its unit: sin(30deg).
- Matrices: [[a,b],[c,d]]. Definite integral: int(f, x, a, b). Sum: sum(f, k, 1, 10). Derivative at a point: diff(f, x, x0).
- Equations and definitions use a single "=" (V1 + 2*V2 = 5). Keep the original left and right sides.
- Do NOT write anything that is not in the image. Do not add result values.`;

export const USER_PROMPT = 'Transcribe this handwritten work into the JSON schema. JSON only.';

const KINDS = new Set(['expr', 'assign', 'equation', 'text']);

// 모델 응답 텍스트에서 JSON 객체를 꺼내 정규화한다.
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new RecognitionError('schema', '응답이 비어 있습니다');
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new RecognitionError('schema', '응답에서 JSON을 찾지 못했습니다', text.slice(0, 200));
  let obj;
  try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) {
    throw new RecognitionError('schema', `JSON 해석 실패: ${e.message}`, text.slice(0, 200));
  }
  if (!obj || !Array.isArray(obj.lines)) throw new RecognitionError('schema', "'lines' 배열이 없습니다", text.slice(0, 200));
  const lines = [];
  obj.lines.forEach((l, idx) => {
    if (!l || typeof l !== 'object') return;
    const calc = typeof l.calc === 'string' ? l.calc.trim() : '';
    const latex = typeof l.latex === 'string' ? l.latex.trim() : '';
    if (!calc && !latex) return;
    let conf = Number(l.confidence);
    if (!Number.isFinite(conf)) conf = 0.5;
    lines.push({
      id: lines.length + 1,
      latex,
      calc,
      kind: KINDS.has(l.kind) ? l.kind : 'expr',
      confidence: Math.min(1, Math.max(0, conf)),
      note: typeof l.note === 'string' ? l.note : '',
      bbox: Array.isArray(l.bbox) && l.bbox.length === 4 ? l.bbox.map(Number) : null,
    });
  });
  const unreadable = Array.isArray(obj.unreadable) ? obj.unreadable.filter((x) => typeof x === 'string') : [];
  return { lines, unreadable };
}

// 각 줄의 calc 를 시험 파싱해 문법 오류를 표시한다 (계산은 하지 않음).
export function checkLines(lines) {
  const probe = new CalcSession();
  for (const l of lines) {
    l.syntaxError = null;
    if (l.kind === 'text' || !l.calc) continue;
    try {
      for (const st of splitStatements(l.calc)) probe.analyze(st);
    } catch (e) {
      l.syntaxError = e.message;
    }
  }
  return lines;
}

function httpMessage(status, body) {
  const base = {
    400: '요청이 거부되었습니다 (이미지 형식이나 모델 이름을 확인하세요)',
    401: 'API 키가 올바르지 않습니다',
    403: 'API 키 권한이 없습니다',
    404: '모델 이름을 찾을 수 없습니다 (설정에서 확인하세요)',
    413: '이미지가 너무 큽니다',
    429: '요청이 너무 많습니다. 잠시 후 다시 시도하세요',
    529: '서버가 혼잡합니다. 잠시 후 다시 시도하세요',
  }[status] ?? `서버 오류 (${status})`;
  let extra = '';
  try { extra = JSON.parse(body)?.error?.message ?? ''; } catch { /* 본문이 JSON 이 아님 */ }
  return extra ? `${base}: ${extra}` : base;
}

async function callOnce({ imageBase64, mediaType, apiKey, model, endpoint, fetchImpl, signal, extraUser }) {
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
    { type: 'text', text: extraUser ? `${USER_PROMPT}\n${extraUser}` : USER_PROMPT },
  ];
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new RecognitionError('timeout', '인식 시간이 초과되었습니다');
    throw new RecognitionError('network', `네트워크 오류: ${e.message}`);
  }
  const bodyText = await res.text();
  if (!res.ok) throw new RecognitionError(res.status >= 500 || res.status === 429 ? 'server' : 'http', httpMessage(res.status, bodyText), { status: res.status });
  let data;
  try { data = JSON.parse(bodyText); } catch { throw new RecognitionError('schema', '서버 응답을 해석할 수 없습니다'); }
  const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (data.stop_reason === 'max_tokens') throw new RecognitionError('schema', '응답이 잘렸습니다 (줄 수가 너무 많음). 영역을 나누어 선택해 보세요');
  return text;
}

// 인식 실행. 스키마 오류나 일시적 서버 오류는 1회 자동 재시도한다.
export async function recognize(opts) {
  const {
    imageBase64, mediaType = 'image/png', apiKey, model = DEFAULT_MODEL, endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 30000,
  } = opts;
  if (!apiKey) throw new RecognitionError('no-key', 'API 키가 설정되지 않았습니다. 설정에서 입력하세요');
  if (!imageBase64) throw new RecognitionError('no-image', '이미지가 없습니다');
  if (!fetchImpl) throw new RecognitionError('network', 'fetch 를 사용할 수 없습니다');

  let attempts = 0;
  let lastErr;
  let extraUser = '';
  while (attempts < 2) {
    attempts++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const text = await callOnce({ imageBase64, mediaType, apiKey, model, endpoint, fetchImpl, signal: ctl.signal, extraUser });
      const parsed = parseModelJson(text);
      if (!parsed.lines.length) throw new RecognitionError('empty', '인식된 줄이 없습니다. 글씨가 포함되도록 영역을 다시 선택하세요');
      checkLines(parsed.lines);
      return { ...parsed, raw: text, attempts, model };
    } catch (e) {
      lastErr = e;
      const retryable = e.code === 'schema' || e.code === 'server' || e.code === 'network' || e.code === 'timeout';
      if (!retryable || attempts >= 2) break;
      if (e.code === 'schema') extraUser = 'Your previous reply was not valid JSON for the schema. Reply with the JSON object only.';
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// 데모/테스트용 인식기: 설계 명세서 2장의 대표 예제를 반환한다.
export function mockRecognize() {
  const lines = [
    { id: 1, latex: '10\\angle 30^\\circ + 5\\angle(-45^\\circ)', calc: '10@30deg + 5@(-45deg)', kind: 'expr', confidence: 0.95, note: '', bbox: null },
    { id: 2, latex: '(3+j4)\\parallel(6-j8)', calc: '(3+j4)||(6-j8)', kind: 'expr', confidence: 0.9, note: '', bbox: null },
    { id: 3, latex: '3V_1 - V_2 = 5', calc: '3V1 - V2 = 5', kind: 'equation', confidence: 0.85, note: '', bbox: null },
    { id: 4, latex: '-V_1 + 2V_2 = 0', calc: '-V1 + 2V2 = 0', kind: 'equation', confidence: 0.55, note: '1 또는 l', bbox: null },
  ];
  return { lines: checkLines(lines), unreadable: [], raw: '(mock)', attempts: 1, model: 'mock' };
}
