/**
 * Google Sheets Apps Script — Send renewal invites via BTS automation API.
 * Copy into Extensions → Apps Script, adjust constants, then run from the sheet.
 */

const BTS_BASE_URL = 'https://your-bts-host.example.com/bts';
const AUTOMATION_SECRET = 'REPLACE_WITH_AUTOMATION_JWT_SECRET';
const AUTOMATION_ISS = 'google-sheets';
const AUTOMATION_AUD = 'bts-automation';
const AUTOMATION_SCOPES = ['automation:jobs:write', 'automation:jobs:run'];
const SHEET_NAME = 'Invitations';
const DRY_RUN_DEFAULT = true;

function createJwt_() {
  const header = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss: AUTOMATION_ISS,
    aud: AUTOMATION_AUD,
    iat: now,
    exp: now + 300,
    scopes: AUTOMATION_SCOPES,
    integration: 'google-sheets',
    requestedBy: Session.getActiveUser()?.getEmail() || 'google-sheets'
  }));
  const signingInput = `${header}.${payload}`;
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(signingInput, AUTOMATION_SECRET)
  );
  return `${signingInput}.${signature}`;
}

function automationFetch_(path, payload) {
  const url = `${BTS_BASE_URL.replace(/\/$/, '')}/api/automation/${path.replace(/^\//, '')}`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${createJwt_()}` },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  };
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 300) {
    throw new Error(`Automation API ${response.getResponseCode()}: ${response.getContentText()}`);
  }
  return JSON.parse(response.getContentText());
}

function collectInvitesFromSheet_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found.`);
  const [headers, ...rows] = sheet.getDataRange().getValues();
  const idx = Object.fromEntries(headers.map((name, i) => [String(name).trim().toLowerCase(), i]));
  ['email', 'renewurl'].forEach((key) => {
    if (idx[key] == null) throw new Error(`Missing column "${key}" in sheet header.`);
  });
  return rows
    .filter((row) => row[idx.email] && row[idx.renewurl])
    .map((row) => ({
      email: row[idx.email],
      renewUrl: row[idx.renewurl],
      firstName: idx.firstname != null ? row[idx.firstname] : '',
      lastName: idx.lastname != null ? row[idx.lastname] : '',
      seats: idx.seats != null ? String(row[idx.seats]) : ''
    }));
}

function buildJobPayload_(invitees) {
  return {
    dryRun: DRY_RUN_DEFAULT,
    params: {
      csv: 'google-sheet',
      template: 'renew-invite',
      subject: 'Renouvellement d’abonnement',
      seasonCode: '2025-2026',
      deadline: '31/08/2025',
      providerLabel: 'HelloAsso',
      invitees
    },
    metadata: {
      source: 'google-sheet',
      sheetUrl: SpreadsheetApp.getActive().getUrl()
    }
  };
}

function sendRenewInvitesFromSheet() {
  const invitees = collectInvitesFromSheet_();
  if (!invitees.length) {
    SpreadsheetApp.getUi().alert('Aucune ligne valide (email + renewUrl) détectée.');
    return;
  }
  const result = automationFetch_('scripts/season.send-renew-invites/jobs', buildJobPayload_(invitees));
  SpreadsheetApp.getUi().alert(`Job ${result.job.id} enregistré (${result.job.status}).`);
}
