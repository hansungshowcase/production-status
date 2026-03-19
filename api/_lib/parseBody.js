// For multipart form data parsing in Vercel serverless
export async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      // Parse multipart boundary
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        reject(new Error('No boundary found'));
        return;
      }
      const boundary = boundaryMatch[1];
      const parts = parseMultipartBuffer(buffer, boundary);
      resolve(parts);
    });
    req.on('error', reject);
  });
}

function parseMultipartBuffer(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length + 2; // skip \r\n

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
