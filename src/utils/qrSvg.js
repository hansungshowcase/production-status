import QRCode from 'qrcode';

/**
 * 203 dpi 흑백 감열 라벨 프린터용 순수 흑백 QR SVG 생성기.
 * 안티앨리어싱·흐림을 방지하기 위해 shape-rendering="crispEdges"와 단일 <path>를 사용한다.
 */
export function generateQrSvg(text, options = {}) {
  const value = String(text ?? '').trim();
  if (!value) {
    throw new Error('QR 코드로 변환할 텍스트가 비어 있습니다.');
  }

  const {
    margin = 2,
    size = '100%',
    errorCorrectionLevel = 'M',
    ariaLabel = '제품 사용설명서 QR 코드',
  } = options;

  const safeMargin = Number.isInteger(margin) && margin >= 0 ? margin : 2;
  const qr = QRCode.create(value, { errorCorrectionLevel });
  const moduleCount = qr.modules.size;
  const data = qr.modules.data;
  const viewBoxSize = moduleCount + (safeMargin * 2);

  const paths = [];
  for (let row = 0; row < moduleCount; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= moduleCount; col += 1) {
      const isDark = col < moduleCount && Boolean(data[(row * moduleCount) + col]);
      if (isDark && runStart === -1) {
        runStart = col;
      } else if (!isDark && runStart !== -1) {
        const x = runStart + safeMargin;
        const y = row + safeMargin;
        const w = col - runStart;
        paths.push(`M${x} ${y}h${w}v1h-${w}z`);
        runStart = -1;
      }
    }
  }

  const escapeAttr = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const safeAttrSize = escapeAttr(size);
  const safeLabel = escapeAttr(ariaLabel);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" width="${safeAttrSize}" height="${safeAttrSize}" shape-rendering="crispEdges" role="img" aria-label="${safeLabel}">`,
    `<rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#FFFFFF"/>`,
    `<path fill="#000000" d="${paths.join('')}"/>`,
    '</svg>',
  ].join('');
}
