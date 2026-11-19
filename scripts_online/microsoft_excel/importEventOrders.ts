/**
 * Office Script — Import event orders via BTS automation API.
 *
 * Reads the configured `EVENT_ORDERS_SHEET` (defaults to "EventOrders"),
 * builds an inline orders payload, and posts it to `scripts/event.import-orders/jobs`.
 */

type ConfigMap = Record<string, string>;

interface AutomationJobResponse {
  job?: {
    id?: string;
    status?: string;
    summary?: string;
  };
}

interface OrderLinePayload {
  seatId: string;
  zoneKey: string;
  tariffCode: string;
  priceCents: number;
  quantity: number;
  holderFirstName?: string;
  holderLastName?: string;
}

interface OrderPayload {
  orderId?: string;
  groupKey: string;
  eventId?: string;
  eventSlug?: string;
  payerEmail: string;
  payerFirstName?: string;
  payerLastName?: string;
  seasonCode?: string;
  venueSlug?: string;
  status: string;
  totalCents: number;
  paymentSplit: number;
  createdAt?: string;
  providerName?: string;
  haOrderId?: string;
  checkoutIntentId?: string;
  lastReturnCode?: string;
  lastWebhookEvent?: string;
  attestationSentAt?: string;
  eventName?: string;
  eventStartsAt?: string;
  eventNotes?: string;
  lines: OrderLinePayload[];
}

const CONFIG_SHEET_NAME = 'BTS_Config';
const LOG_SHEET_NAME = 'BTS Automations';

async function main(workbook: ExcelScript.Workbook) {
  const config = readConfig(workbook);
  const baseUrl = requireConfig(config, 'BASE_URL');
  const secret = requireConfig(config, 'AUTOMATION_SECRET');
  const issuer = config.ISSUER || 'excel-online';
  const audience = config.AUDIENCE || 'bts-automation';
  const scopes = (config.SCOPES || 'automation:jobs:write automation:jobs:run automation:events:write')
    .split(/\s+/)
    .filter((token) => token.trim().length > 0);

  const sheetName = config.EVENT_ORDERS_SHEET || 'EventOrders';
  const dryRun = parseBoolean(config.EVENT_IMPORT_DRY_RUN, true);
  const force = parseBoolean(config.EVENT_IMPORT_FORCE, false);
  const sendEmail = parseBoolean(config.EVENT_IMPORT_SEND_EMAIL, false);

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" introuvable. Configurez EVENT_ORDERS_SHEET ou créez la feuille.`);
  }

  const orders = collectOrders(sheet);
  if (!orders.length) {
    throw new Error('Aucune commande valide détectée (payerEmail + eventSlug/eventId + zoneKey/seatId).');
  }

  const token = await createJwt(secret, issuer, audience, scopes, 'excel-online');
  const payload = {
    dryRun,
    force,
    sendEmail,
    orders,
    metadata: {
      source: 'excel-online',
      sheetUrl: '',
      sheetName
    }
  };

  const response = await callAutomation(
    baseUrl,
    'scripts/event.import-orders/jobs',
    token,
    payload
  );

  const job = response.job;
  const summary = job?.summary || '';
  appendLog(workbook, {
    scriptId: 'event.import-orders',
    jobId: job?.id || 'unknown',
    status: job?.status || 'queued',
    recordCount: orders.length,
    sheetName,
    notes: typeof summary === 'string' ? summary : ''
  });
}

function readConfig(workbook: ExcelScript.Workbook): ConfigMap {
  const defaults: ConfigMap = {
    BASE_URL: '',
    AUTOMATION_SECRET: '',
    ISSUER: 'excel-online',
    AUDIENCE: 'bts-automation',
    SCOPES: 'automation:jobs:write automation:jobs:run automation:events:write',
    EVENT_ORDERS_SHEET: 'EventOrders',
    EVENT_IMPORT_DRY_RUN: 'true',
    EVENT_IMPORT_FORCE: 'false',
    EVENT_IMPORT_SEND_EMAIL: 'false'
  };
  const sheet = workbook.getWorksheet(CONFIG_SHEET_NAME);
  if (!sheet) return defaults;
  const used = sheet.getUsedRange();
  if (!used) return defaults;
  const values = used.getValues() as (string | number | boolean)[][];
  const map: ConfigMap = { ...defaults };
  for (let r = 1; r < values.length; r++) {
    const keyRaw = values[r][0];
    const valueRaw = values[r][1];
    if (!keyRaw) continue;
    const key = String(keyRaw).trim().toUpperCase();
    map[key] = valueRaw === undefined ? '' : String(valueRaw);
  }
  return map;
}

function requireConfig(config: ConfigMap, key: string): string {
  const value = config[key];
  if (!value) throw new Error(`Configuration manquante pour ${key}. Exécutez ConfigureBts.`);
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function collectOrders(sheet: ExcelScript.Worksheet) {
  const used = sheet.getUsedRange();
  if (!used) return [];
  const values = used.getValues() as (string | number | boolean)[][];
  if (values.length <= 1) return [];

  const headers = values[0].map((v) => String(v || '').trim().toLowerCase());
  const index = new Map<string, number>();
  headers.forEach((name, idx) => {
    if (name) {
      index.set(name, idx);
    }
  });

  function get(row: (string | number | boolean)[], key: string): string {
    const idx = index.get(key);
    if (idx === undefined || idx < 0 || idx >= row.length) return '';
    return normalizeCell(row[idx]);
  }

  function getNumber(row: (string | number | boolean)[], key: string, fallback = 0): number {
    const value = get(row, key);
    if (!value) return fallback;
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  const ordersMap = new Map<string, OrderPayload>();

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const payerEmail = get(row, 'payeremail');
    const eventSlug = get(row, 'eventslug');
    const eventId = get(row, 'eventid');
    const zoneKey = get(row, 'zonekey');
    const seatId = get(row, 'seatid');

    if (!payerEmail || (!eventSlug && !eventId) || (!zoneKey && !seatId)) {
      continue;
    }

    const orderId = get(row, 'orderid');
    const groupKeyRaw = get(row, 'groupkey');
    const identifier =
      groupKeyRaw ||
      orderId ||
      `${payerEmail.toLowerCase()}::${eventSlug || eventId || 'event'}::${r}`;

    if (!ordersMap.has(identifier)) {
      ordersMap.set(identifier, {
        orderId: orderId || undefined,
        groupKey: groupKeyRaw || identifier,
        eventId: eventId || undefined,
        eventSlug: eventSlug || undefined,
        payerEmail,
        payerFirstName: get(row, 'payerfirstname') || undefined,
        payerLastName: get(row, 'payerlastname') || undefined,
        seasonCode: get(row, 'seasoncode') || undefined,
        venueSlug: get(row, 'venueslug') || undefined,
        status: (get(row, 'status') || 'paid').toLowerCase(),
        totalCents: getNumber(row, 'totalcents', 0),
        paymentSplit: getNumber(row, 'paymentsplit', 1),
        createdAt: get(row, 'createdat') || undefined,
        providerName: get(row, 'providername') || undefined,
        haOrderId: get(row, 'haorderid') || undefined,
        checkoutIntentId: get(row, 'checkoutintentid') || undefined,
        lastReturnCode: get(row, 'lastreturncode') || undefined,
        lastWebhookEvent: get(row, 'lastwebhookevent') || undefined,
        attestationSentAt: get(row, 'attestationsentat') || undefined,
        eventName: get(row, 'eventname') || undefined,
        eventStartsAt: get(row, 'eventstartsat') || undefined,
        eventNotes: get(row, 'eventnotes') || undefined,
        lines: [] as OrderLinePayload[]
      });
    }

    const order = ordersMap.get(identifier) as OrderPayload;
    const priceCents = getNumber(row, 'pricecents', NaN);
    let cents = priceCents;
    if (!Number.isFinite(cents) || cents <= 0) {
      const priceEuro = getNumber(row, 'priceeuro', NaN);
      if (Number.isFinite(priceEuro) && priceEuro > 0) {
        cents = Math.round(priceEuro * 100);
      } else {
        cents = 0;
      }
    }

    const quantity = Math.max(1, getNumber(row, 'quantity', 1));
    order.lines.push({
      seatId,
      zoneKey,
      tariffCode: (get(row, 'tariffcode') || get(row, 'tariff') || 'NORMAL').toUpperCase(),
      priceCents: cents,
      quantity,
      holderFirstName: get(row, 'holderfirstname') || undefined,
      holderLastName: get(row, 'holderlastname') || undefined
    });
  }

  const orders: OrderPayload[] = [];
  ordersMap.forEach((order) => {
    if (!order.lines.length) return;
    if (!order.eventSlug && !order.eventId) return;
    if (!order.totalCents || order.totalCents <= 0) {
      order.totalCents = order.lines.reduce((acc: number, line: OrderLinePayload) => {
        return acc + Number(line.priceCents || 0) * Number(line.quantity || 1);
      }, 0);
    }
    orders.push(order);
  });
  return orders;
}

function normalizeCell(value: string | number | boolean): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toString();
    return value.toString();
  }
  return String(value).trim();
}

async function callAutomation(
  baseUrl: string,
  path: string,
  token: string,
  payload: unknown
) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/automation/${path.replace(/^\//, '')}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Automation API ${response.status}: ${text}`);
  }
  return (await response.json()) as AutomationJobResponse;
}

async function createJwt(
  secret: string,
  issuer: string,
  audience: string,
  scopes: string[],
  integration: string
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: audience,
    iat: now,
    nbf: now - 30,
    exp: now + 600,
    scopes,
    integration,
    requestedBy: integration
  };

  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const signingKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(signingInput));
  const signatureSegment = base64UrlEncode(signatureBuffer);
  return `${signingInput}.${signatureSegment}`;
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function appendLog(
  workbook: ExcelScript.Workbook,
  entry: { scriptId: string; jobId: string; status: string; recordCount: number; sheetName: string; notes?: string }
) {
  let sheet = workbook.getWorksheet(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = workbook.addWorksheet(LOG_SHEET_NAME);
    sheet.getRange('A1:F1').setValues([['Timestamp', 'Script', 'Job ID', 'Status', 'Records', 'Notes']]);
  }
  const used = sheet.getUsedRange();
  const nextRow = used ? used.getRowCount() : 1;
  const target = sheet.getRangeByIndexes(nextRow, 0, 1, 6);
  target.setValues([
    [
      new Date().toISOString(),
      entry.scriptId,
      entry.jobId,
      entry.status,
      entry.recordCount,
      entry.notes || ''
    ]
  ]);
}

// Office Scripts expects a top-level main function
(main as unknown);
