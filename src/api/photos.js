import request from './client';

const PHOTO_TARGET_BYTES = 1200 * 1024;

function canvasToPhotoFile(canvas, name, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        resolve(new File([blob], `${name}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      quality
    );
  });
}

async function preparePhoto(file, maxWidth = 1280) {
  if (!file || typeof Image === 'undefined' || !/^image\//i.test(file.type || '')) return file;
  if (file.size <= PHOTO_TARGET_BYTES && /^image\/jpe?g$/i.test(file.type || '')) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
      const attempts = [
        { width: canvas.width, quality: 0.78 },
        { width: 1200, quality: 0.72 },
        { width: 1000, quality: 0.66 },
        { width: 850, quality: 0.58 },
      ];
      let lastCompressed = null;

      for (const attempt of attempts) {
        let targetCanvas = canvas;
        if (attempt.width < canvas.width) {
          const ratio = attempt.width / canvas.width;
          targetCanvas = document.createElement('canvas');
          targetCanvas.width = Math.max(1, Math.round(canvas.width * ratio));
          targetCanvas.height = Math.max(1, Math.round(canvas.height * ratio));
          targetCanvas.getContext('2d').drawImage(canvas, 0, 0, targetCanvas.width, targetCanvas.height);
        }

        const compressed = await canvasToPhotoFile(targetCanvas, name, attempt.quality);
        if (compressed) lastCompressed = compressed;
        if (compressed && compressed.size <= PHOTO_TARGET_BYTES) {
          resolve(compressed);
          return;
        }
      }

      resolve(lastCompressed || file);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

async function preparePhotoFormData(data) {
  if (!(data instanceof FormData)) return data;
  const photo = data.get('photo');
  if (!(photo instanceof File)) return data;

  const prepared = await preparePhoto(photo);
  if (prepared === photo) return data;

  const next = new FormData();
  for (const [key, value] of data.entries()) {
    next.append(key, key === 'photo' ? prepared : value);
  }
  return next;
}

export async function uploadPhoto(data) {
  const body = await preparePhotoFormData(data);
  return request('/photos', { method: 'POST', body });
}

export function deletePhoto(id, actor) {
  if (!id) throw new Error('photo ID가 필요합니다');
  return request(`/photos/${id}`, { method: 'DELETE', body: { actor: actor || '시스템' } });
}
