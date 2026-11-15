// 이미지 전처리: 긴 변 기준 축소, 투명 배경을 흰색으로 합성, base64 변환.

export function fitSize(w, h, max = 2000) {
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h, scaled: false };
  const k = max / long;
  return { width: Math.round(w * k), height: Math.round(h * k), scaled: true };
}

function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 열 수 없습니다')); };
    img.src = url;
  });
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

// 입력 Blob → { blob, base64, mediaType, width, height }
export async function prepareImage(blob, max = 2000) {
  const bmp = await loadBitmap(blob);
  const { width, height } = fitSize(bmp.width, bmp.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0, width, height);
  if (bmp.close) bmp.close();
  // 필기는 PNG 가 선명하다. 매우 큰 경우에만 JPEG 로 줄인다.
  let out = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (out.size > 4.5 * 1024 * 1024) out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  return { blob: out, base64: await blobToBase64(out), mediaType: out.type, width, height };
}

export async function readClipboardImage() {
  if (!navigator.clipboard?.read) throw new Error('이 브라우저는 클립보드 읽기를 지원하지 않습니다. 길게 눌러 붙여넣기를 사용하세요');
  const items = await navigator.clipboard.read();
  for (const it of items) {
    const type = it.types.find((t) => t.startsWith('image/'));
    if (type) return it.getType(type);
  }
  throw new Error('클립보드에 이미지가 없습니다');
}
