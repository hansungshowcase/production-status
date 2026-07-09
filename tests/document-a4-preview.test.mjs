import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const salesOrderCardCss = readFileSync(
  new URL('../src/components/sales/SalesOrderCard.css', import.meta.url),
  'utf8'
);
const workerStationCss = readFileSync(
  new URL('../src/pages/WorkerStationViewPage.css', import.meta.url),
  'utf8'
);
const orderEntryCss = readFileSync(
  new URL('../src/pages/OrderEntryPage.css', import.meta.url),
  'utf8'
);

test('shipping and delivery document preview sheet is styled as an A4 page', () => {
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet\s*\{[\s\S]*aspect-ratio:\s*210\s*\/\s*297;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet\s*\{[\s\S]*width:\s*min\(190mm,\s*calc\(100%\s*-\s*20px\)\);/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet\s*\{[\s\S]*height:\s*277mm;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet\s*\{[\s\S]*padding:\s*0;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-guide\s*\{[\s\S]*font-size:\s*16px;[\s\S]*flex:\s*1 1 auto;[\s\S]*justify-content:\s*center;/
  );
  assert.match(
    salesOrderCardCss,
    /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*\.sales-order-card__document-sheet\s*\{[\s\S]*height:\s*277mm;/
  );
});

test('shipping and delivery document preview keeps Korean labels readable', () => {
  const salesOrderCardSource = readFileSync(
    new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url),
    'utf8'
  );
  const previewStart = salesOrderCardSource.indexOf('sales-order-card__document-sheet');
  const previewEnd = salesOrderCardSource.indexOf('{renderDocumentGuide(documentPreview.levelingGuide)}', previewStart);
  const previewSource = salesOrderCardSource.slice(previewStart, previewEnd);

  for (const label of ['주문일', '출고일', '사업자번호', '전화', '상호/성명', '주소', '월/일', '품목명', '규격', '수량', '적요', '창고명', '배송담당자', '수취인', '수평확인완료']) {
    assert.match(previewSource, new RegExp(label));
  }
  assert.doesNotMatch(previewSource, /[?�]{2,}|怨|湲|二쇰|異쒓|諛곗|李쎄|洹쒓|곸슂/);
});

test('shipping document preview only shows delivery-manager signature and hides guide section', () => {
  const salesOrderCardSource = readFileSync(
    new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url),
    'utf8'
  );

  assert.match(salesOrderCardSource, /documentPreview\.type === 'shipping'[\s\S]*<th>배송담당자<\/th><td className="sales-order-card__document-sign-cell" \/>/);
  assert.match(salesOrderCardSource, /documentPreview\.type !== 'shipping'[\s\S]*<th>수취인<\/th><td className="sales-order-card__document-sign-cell" \/>/);
  assert.match(salesOrderCardSource, /documentPreview\.type !== 'shipping'[\s\S]*<th>수평확인완료<\/th><td className="sales-order-card__document-sign-cell" \/>/);
  assert.match(salesOrderCardSource, /renderDocumentGuide\(documentPreview\.levelingGuide\)/);
  assert.equal(salesOrderCardSource.includes('잔금내역'), true);
});

test('delivery document preview keeps large signature cells for all three signers', () => {
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sign-cell\s*\{[\s\S]*min-width:\s*42mm;/
  );
});

test('document preview item table uses larger readable rows', () => {
  assert.match(salesOrderCardCss, /\.sales-order-card__document-items\s*\{[\s\S]*font-size:\s*14px;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-items th\s*\{[\s\S]*height:\s*32px;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-items th\s*\{[\s\S]*font-size:\s*14px;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-items td\s*\{[\s\S]*height:\s*32px;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items\s*\{[\s\S]*flex:\s*0 0 auto;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items th,[\s\S]*\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items td\s*\{[\s\S]*height:\s*36px;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-guide--shipping\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*min-height:\s*64mm;/);
  assert.match(salesOrderCardCss, /\.sales-order-card__document-guide--shipping\s*\{[\s\S]*font-size:\s*14px;/);
});

test('document preview keeps print actions visible at the top of the scroll panel', () => {
  const salesOrderCardSource = readFileSync(
    new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url),
    'utf8'
  );

  assert.match(salesOrderCardSource, /import\s+\{\s*createPortal\s*\}\s+from\s+'react-dom';/);
  assert.match(salesOrderCardSource, /createPortal\([\s\S]*sales-order-card__document-modal[\s\S]*document\.body[\s\S]*\)/);
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-toolbar\s*\{[\s\S]*position:\s*sticky;[\s\S]*top:\s*0;[\s\S]*z-index:\s*1;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-panel\s*\{[\s\S]*overflow:\s*auto;/
  );
});

test('document preview lowers the supplier box and shows more shipping item rows', () => {
  const salesOrderCardSource = readFileSync(
    new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url),
    'utf8'
  );

  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-supplier-wrap\s*\{[\s\S]*padding-top:\s*8px;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-stamp\s*\{[\s\S]*top:\s*26px;/
  );
  assert.match(
    salesOrderCardSource,
    /documentPreview\.type === 'shipping' \? ' sales-order-card__document-sheet--shipping' : ''/
  );
  assert.match(
    salesOrderCardSource,
    /Array\.from\(\{ length: documentPreview\.type === 'shipping' \? 9 : 7 \}/
  );
});

test('shipping document preview widens specification and prevents key columns from wrapping', () => {
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items th:nth-child\(3\),[\s\S]*\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items td:nth-child\(3\)\s*\{[\s\S]*width:\s*26%;[\s\S]*white-space:\s*nowrap;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items th:nth-child\(5\),[\s\S]*\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items td:nth-child\(5\)\s*\{[\s\S]*width:\s*24%;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items th:nth-child\(4\),[\s\S]*\.sales-order-card__document-sheet--shipping \.sales-order-card__document-items td:nth-child\(6\)\s*\{[\s\S]*white-space:\s*nowrap;/
  );
});

test('shipping document preview keeps driver information visible inside the A4 sheet', () => {
  assert.doesNotMatch(
    salesOrderCardCss,
    /\.sales-order-card__document-sheet\s*\{[\s\S]*overflow:\s*hidden;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-guide--shipping\s*\{[\s\S]*min-height:\s*64mm;/
  );
  assert.match(
    salesOrderCardCss,
    /\.sales-order-card__document-guide--shipping \.sales-order-card__document-guide-driver\s*\{[\s\S]*line-height:\s*1\.45;/
  );
});

test('work order image viewer wraps the image without forcing an A4 blank area', () => {
  assert.doesNotMatch(
    workerStationCss,
    /\.sv-work-order-viewer__body\s*\{[\s\S]*aspect-ratio:\s*210\s*\/\s*297;/
  );
  assert.match(
    workerStationCss,
    /\.sv-work-order-viewer__body\s*\{[\s\S]*padding:\s*0;/
  );
  assert.match(
    workerStationCss,
    /\.sv-work-order-viewer__image\s*\{[\s\S]*width:\s*auto;[\s\S]*height:\s*auto;[\s\S]*max-width:\s*100%;[\s\S]*max-height:\s*calc\(100vh - 74px\);[\s\S]*object-fit:\s*contain;/
  );
});

test('ocr confirmation preview shows work order image three times larger', () => {
  assert.match(
    orderEntryCss,
    /\.ocr-confirm\s*\{[\s\S]*max-width:\s*min\(96vw,\s*1500px\);/
  );
  assert.match(
    orderEntryCss,
    /\.ocr-confirm__image\s*\{[\s\S]*max-height:\s*600px;/
  );
});
