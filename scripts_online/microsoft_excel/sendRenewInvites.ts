/**
 * Office Script — Send renewal invitations via BTS automation API.
 *
 * Reads the sheet configured under `INVITES_SHEET` (defaults to "Invitations"),
 * posts invitees to `scripts/season.send-renew-invites/jobs`, and logs the
 * resulting job in the "BTS Automations" sheet.
 */

type ConfigMap = Record<string, string>;

interface AutomationJobResponse {
  job?: {
    id?: string;
    status?: string;
  };
}

interface InviteePayload {
  email: string;
  renewUrl: string;
  firstName?: string;
  lastName?: string;
  seats?: string;
}

const CONFIG_SHEET_NAME = 'BTS_Config';
const LOG_SHEET_NAME = 'BTS Automations';

async function main(workbook: ExcelScript.Workbook) {
  const config = readConfig(workbook);
  const baseUrl = requireConfig(config, 'BASE_URL');
  const secret = requireConfig(config, 'AUTOMATION_SECRET');
  const issuer = config.ISSUER || 'excel-online';
  const audience = config.AUDIENCE || 'bts-automation';
  const scopes = (config.SCOPES || '').split(/\s+/).filter((token) => token.trim().length > 0);
  const sheetName = config.INVITES_SHEET || 'Invitations';
  const dryRun = parseBoolean(config.RENEW_DRY_RUN, false);

  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" introuvable. Configurez INVITES_SHEET ou créez la feuille.`);
  }

  const invitees = collectInvitees(sheet);
  if (!invitees.length) {
    throw new Error('Aucune ligne valide (email + renewUrl) détectée.');
  }

  const token = await createJwt(secret, issuer, audience, scopes, 'excel-online');
  const payload = {
    dryRun,
    params: {
      csv: 'excel-online',
      template: 'renew-invite',
      invitees
    },
    metadata: {
      source: 'excel-online',
      sheetUrl: '',
      sheetName
    }
  };

  const response = await callAutomation(
    baseUrl,
    'scripts/season.send-renew-invites/jobs',
    token,
    payload
  );

  const job = response.job;
  appendLog(workbook, {
    scriptId: 'season.send-renew-invites',
    jobId: job?.id || 'unknown',
    status: job?.status || 'queued',
    recordCount: invitees.length,
    sheetName
  });
}

function readConfig(workbook: ExcelScript.Workbook): ConfigMap {
  const defaults: ConfigMap = {
    BASE_URL: '',
    AUTOMATION_SECRET: '',
    ISSUER: 'excel-online',
    AUDIENCE: 'bts-automation',
    SCOPES: 'automation:jobs:write automation:jobs:run',
    INVITES_SHEET: 'Invitations',
    RENEW_DRY_RUN: 'false'
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
  if (!value) {
    throw new Error(`Configuration manquante pour ${key}. Exécutez le script ConfigureBts.`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function collectInvitees(sheet: ExcelScript.Worksheet) {
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

  const invitees: InviteePayload[] = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const email = get(row, 'email');
    const renewUrl = get(row, 'renewurl');
    if (!email || !renewUrl) continue;
    invitees.push({
      email,
      renewUrl,
      firstName: get(row, 'firstname') || undefined,
      lastName: get(row, 'lastname') || undefined,
      seats: get(row, 'seats') || undefined
    });
  }
  return invitees;
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
  entry: { scriptId: string; jobId: string; status: string; recordCount: number; sheetName: string }
) {
  let sheet = workbook.getWorksheet(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = workbook.addWorksheet(LOG_SHEET_NAME);
    sheet.getRange('A1:F1').setValues([
      ['Timestamp', 'Script', 'Job ID', 'Status', 'Records', 'Sheet']
    ]);
  }
  const tableRange = sheet.getUsedRange();
  const nextRow = tableRange ? tableRange.getRowCount() : 1;
  const target = sheet.getRangeByIndexes(nextRow, 0, 1, 6);
  target.setValues([
    [
      new Date().toISOString(),
      entry.scriptId,
      entry.jobId,
      entry.status,
      entry.recordCount,
      entry.sheetName
    ]
  ]);
}
