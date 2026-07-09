function safeFilenamePart(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  return cleaned || fallback;
}

function extensionFromPath(path) {
  const cleanPath = String(path || '').split('?')[0].split('#')[0];
  const match = cleanPath.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : 'jpg';
}

export function getSalesDetailPreProductionItems() {
  return [];
}

export function getOrderDetailPhotoDownloadProps(photo, order = {}) {
  const photoId = photo?.id;
  const filePath = photo?.file_path || '';
  const href = photoId
    ? `/api/photos/${encodeURIComponent(photoId)}?download=1`
    : filePath;
  const clientName = safeFilenamePart(order.client_name, 'order');
  const orderId = safeFilenamePart(order.id, 'unknown');
  const suffix = photoId ? String(photoId) : 'photo';
  const ext = extensionFromPath(filePath);

  return {
    href,
    download: `${clientName}-photo-${orderId}-${suffix}.${ext}`,
  };
}

export function shouldShowPackingPhotoDownload(order = {}) {
  return Boolean(order.packing_photo_url || order.status === 'shipped' || order.status === '출고완료' || order.ship_date);
}
