import assert from 'node:assert/strict';
import test from 'node:test';

import { handleStartProcess } from '../api/processes/[id]/start.js';
import { handleCompleteProcess } from '../api/processes/[id]/complete.js';
import { handleWorkerShip } from '../api/orders/[id]/worker-ship.js';
import { handlePost as handlePhotoPost } from '../api/photos/index.js';
import { canWorkerAccessDepartment } from '../shared/workerAccess.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
  };
}

const restrictedWorker = { role: 'worker', actor: '이정섭 부장' };

test('canonical worker departments allow assigned steps and preserve unmapped-worker access', () => {
  assert.equal(canWorkerAccessDepartment('이정섭 부장', '도면설계'), true);
  assert.equal(canWorkerAccessDepartment('이정섭 부장', '용접작업'), false);
  assert.equal(canWorkerAccessDepartment('기존 미등록 작업자', '용접작업'), true);
});

test('worker cannot start a persisted process outside the canonical department map', async () => {
  let mutations = 0;
  const db = {
    async execute() {
      return { rows: [{ id: 91, order_id: 9, step_name: '용접작업', status: 'waiting' }] };
    },
    async atomicBatch() {
      mutations += 1;
      return [{ rows: [] }];
    },
  };
  const res = response();
  await handleStartProcess(
    { method: 'PATCH', query: { id: '91' }, body: {}, headers: {} },
    res,
    {
      db,
      rateLimitCheck: () => true,
      requireWorkerAction: async () => restrictedWorker,
      notifyInternalStart: async () => { throw new Error('notification must not run'); },
    },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(mutations, 0);
});

test('worker cannot complete a persisted process outside the canonical department map', async () => {
  let mutations = 0;
  const db = {
    async execute({ sql }) {
      if (sql === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ id: 92, order_id: 9, step_name: '용접작업', status: 'in_progress' }] };
      }
      throw new Error('DB read after authorization boundary');
    },
    async atomicBatch() {
      mutations += 1;
      return [{ rows: [] }];
    },
  };
  const res = response();
  await handleCompleteProcess(
    { method: 'PATCH', query: { id: '92' }, body: {}, headers: {} },
    res,
    {
      db,
      rateLimitCheck: () => true,
      requireWorkerAction: async () => restrictedWorker,
      notify: async () => { throw new Error('notification must not run'); },
      notifyInternalCompletion: async () => { throw new Error('notification must not run'); },
    },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(mutations, 0);
});

test('worker direct shipping checks the shipping department before mutation', async () => {
  let shippingCalls = 0;
  const res = response();
  await handleWorkerShip(
    { method: 'PATCH', query: { id: '9' }, body: {}, headers: {} },
    res,
    {
      db: { async execute() { return { rows: [{ id: 9 }] }; } },
      rateLimitCheck: () => true,
      requireWorkerAction: async () => restrictedWorker,
      completeOrderShipping: async () => {
        shippingCalls += 1;
        return { status: 200, body: { id: 9, status: 'shipped' } };
      },
    },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(shippingCalls, 0);
});

test('worker photo upload checks the persisted process step before storage or writes', async () => {
  let storageCalls = 0;
  let writes = 0;
  const parts = [
    { name: 'order_id', filename: null, data: Buffer.from('9') },
    { name: 'process_id', filename: null, data: Buffer.from('93') },
    { name: 'uploaded_by', filename: null, data: Buffer.from(restrictedWorker.actor) },
    {
      name: 'photo',
      filename: 'fixture.png',
      contentType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
  ];
  const db = {
    async execute({ sql }) {
      if (sql.startsWith('SELECT * FROM orders')) return { rows: [{ id: 9, client_name: 'fixture' }] };
      if (sql.startsWith('SELECT id, step_name FROM processes')) {
        return { rows: [{ id: 93, step_name: '용접작업' }] };
      }
      writes += 1;
      if (sql.includes('INSERT INTO photos')) return { rows: [{ id: 1 }] };
      if (sql.startsWith('SELECT * FROM photos')) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
  const res = response();
  await handlePhotoPost(
    { headers: {}, auth: restrictedWorker },
    res,
    {
      db,
      parseMultipart: async () => parts,
      storeImageFile: async () => {
        storageCalls += 1;
        return { url: 'https://example.com/photo.png', rollbackUrl: null };
      },
    },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(storageCalls, 0);
  assert.equal(writes, 0);
});

test('passwordless selected worker remains subject to the persisted shipping department', async () => {
  let shippingCalls = 0;
  const res = response();
  await handleWorkerShip({method:'PATCH',query:{id:'9'},body:{actor:restrictedWorker.actor},headers:{}},res,{db:{async execute(){return {rows:[{id:9}]};}},rateLimitCheck:()=>true,completeOrderShipping:async()=>{shippingCalls++;return {status:200,body:{}};}});
  assert.equal(res.statusCode,403);
  assert.equal(shippingCalls,0);
});
