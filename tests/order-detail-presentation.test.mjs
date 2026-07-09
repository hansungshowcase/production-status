import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOrderDetailPhotoDownloadProps,
  getSalesDetailPreProductionItems,
  shouldShowPackingPhotoDownload,
} from '../src/pages/orderDetailPresentation.js';

test('sales detail does not expose internal pre-production checklist fields', () => {
  const items = getSalesDetailPreProductionItems({
    instruction_check: true,
    material_drawing: false,
    laser_drawing: true,
    material_order_received: false,
    material_order_completed: false,
    material_received: true,
  });

  assert.deepEqual(items, []);
});

test('order detail photos use direct download attributes', () => {
  const props = getOrderDetailPhotoDownloadProps(
    { id: 42, file_path: 'https://blob.example.com/photo.jpg' },
    { id: 7, client_name: 'ACME/Store' },
  );

  assert.equal(props.href, '/api/photos/42?download=1');
  assert.equal(props.download, 'ACME_Store-photo-7-42.jpg');
});

test('order detail photo download falls back to file path without an id', () => {
  const props = getOrderDetailPhotoDownloadProps(
    { file_path: 'https://blob.example.com/photo.png' },
    { id: 8, client_name: '' },
  );

  assert.equal(props.href, 'https://blob.example.com/photo.png');
  assert.equal(props.download, 'order-photo-8-photo.png');
});

test('sales card shows packing photo download before shipping when photo exists', () => {
  assert.equal(shouldShowPackingPhotoDownload({
    status: 'in_production',
    packing_photo_url: 'https://blob.example.com/packing.jpg',
  }), true);
  assert.equal(shouldShowPackingPhotoDownload({
    status: 'in_production',
    packing_photo_url: '',
  }), false);
  assert.equal(shouldShowPackingPhotoDownload({
    status: 'shipped',
    packing_photo_url: '',
  }), true);
});
