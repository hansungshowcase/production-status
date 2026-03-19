// For multipart form data parsing in Vercel serverless
export async function parseMultipart(req) {
  // Vercel serverless: body may already be a Buffer or need streaming
  let buffer;
  if (req.body && Buffer.isBuffer(req.body)) {
    buffer = req.body;
  } else if (req.body && typeof req.body === 'string') {
    buffer = Buffer.from(req.body, 'binary');
  } else {
    // Fallback: stream approach
    buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) {
    throw new Error('No boundary found');
  }
  const boundary = boundaryMatch[1].trim();
  return parseMultipartBuffer(buffer, boundary);
}

function parseMultipartBuffer(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuffer);
  if (start === -1) return parts;
  start += boundaryBuffer.length + 2; // skip \r\n

  while (true) {
    const end = buffer.indexOf(boundaryBuffer, start);
    if (end === -1) break;

    const part = buffer.slice(start, end - 2); // remove trailing \r\n
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = end + boundaryBuffer.length + 2; continue; }

    const headerStr = part.slice(0, headerEnd).toString('utf-8');
    const body = part.slice(headerEnd + 4);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
      data: body,
    });

    start = end + boundaryBuffer.length + 2;
  }

  return parts;
}

export function getFilePart(parts, fieldName) {
  return parts.find(p => p.name === fieldName && p.filename);
}

export function getFieldValue(parts, fieldName) {
  const part = parts.find(p => p.name === fieldName && !p.filename);
  return part ? part.data.toString('utf-8') : null;
}
