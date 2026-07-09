import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadPackingPhotos } from '../src/pages/packingPhotoUpload.js';

function createFakeFormData() {
  return {
    fields: [],
    append(key, value) {
      this.fields.push([key, value]);
    },
  };
}

test('packing photos are uploaded concurrently with required fields', async () => {
  let resolveUploads;
  const gate = new Promise((resolve) => {
    resolveUploads = resolve;
  });
  const calls = [];

  const promise = uploadPackingPhotos({
    files: ['photo-a', 'photo-b'],
    orderId: 10,
    processId: 20,
    workerName: '작업자A',
    createFormData: createFakeFormData,
    uploadPhoto: async (formData) => {
      calls.push(formData.fields);
      await gate;
      return { ok: true };
    },
  });

  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    ['photo', 'photo-a'],
    ['order_id', 10],
    ['process_id', 20],
    ['uploaded_by', '작업자A'],
  ]);

  resolveUploads();
  await promise;
});
