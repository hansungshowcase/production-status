import { cors } from '../_lib/cors.js';

const DEPARTMENTS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장'];

const DEPARTMENT_STEP_MAP = {
  '도면설계': '도면설계',
  '레이저작업': '레이저작업',
  'V-커팅작업': 'V-커팅작업',
  '절곡작업': '절곡작업',
  '용접작업': '용접작업',
  '분체작업': '분체작업',
  '조립작업': '조립작업',
  '설비작업': '설비작업',
  '포장': '포장',
};

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  return res.json(DEPARTMENTS.map(dept => ({
    name: dept,
    step: DEPARTMENT_STEP_MAP[dept],
  })));
});
