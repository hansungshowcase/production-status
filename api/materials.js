import { loadMaterialsData } from './_lib/materialsSource.js';

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export async function handleMaterials(req, res, dependencies = {}) {
  setNoStoreHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  }

  try {
    const load = dependencies.loadMaterialsData ?? loadMaterialsData;
    const refresh = queryValue(req.query?.refresh) === '1';
    const result = await load({ refresh });
    return res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const message = error?.publicMessage
      || (status === 500 ? '자재 현황을 불러오지 못했습니다.' : error?.message)
      || '자재 현황을 불러오지 못했습니다.';
    return res.status(status).json({ error: { message, status } });
  }
}

export default function materialsHandler(req, res) {
  return handleMaterials(req, res);
}
