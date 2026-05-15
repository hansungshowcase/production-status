import { createSign } from 'node:crypto';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SHEET_ID = '1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM';
const DEFAULT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzHiJ9RSBV3Y4cIgYOP1Y-d7zgfyjqRIrFSxtqCYd9Tg46RDzjUA_k8KPaFUBLRFgR1/exec';
const DEFAULT_WEBHOOK_SECRET = 'hansung-production-status';

let cachedToken = null;

function orderValues(order) {
  return [
    order.order_date || '',
    order.due_date || '',
    order.sales_person || '',
    order.client_name || '',
    '',
    '',
    '',
    '',
    order.phone || '',
  ];
}

async function appendViaWebhook(order) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
  if (!webhookUrl) {
    return { skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET,
        sheetId: 0,
        values: orderValues(order),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Google Sheets webhook failed: ${response.status}`);
    }

    return { skipped: false };
  } finally {
    clearTimeout(timeout);
  }
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getServiceAccountConfig() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      email: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  return {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
  };
}

function normalizePrivateKey(privateKey) {
  return privateKey ? privateKey.replace(/\\n/g, '\n') : '';
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const { email, privateKey } = getServiceAccountConfig();
  const normalizedKey = normalizePrivateKey(privateKey);
  if (!email || !normalizedKey) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }));
  const unsignedJwt = `${header}.${claim}`;
  const signature = createSign('RSA-SHA256')
    .update(unsignedJwt)
    .sign(normalizedKey, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const jwt = `${unsignedJwt}.${signature}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000,
  };
  return cachedToken.token;
}

export async function appendOrderToSheet(order) {
  const webhookResult = await appendViaWebhook(order);
  if (!webhookResult.skipped) {
    return webhookResult;
  }

  const sheetId = process.env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
  const sheetRange = process.env.GOOGLE_SHEET_RANGE || 'A:E';
  const token = await getAccessToken();
  if (!sheetId || !sheetRange || !token) {
    return { skipped: true };
  }

  const range = encodeURIComponent(sheetRange);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: [orderValues(order)],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Google Sheets append failed: ${response.status}`);
    }

    return { skipped: false };
  } finally {
    clearTimeout(timeout);
  }
}
