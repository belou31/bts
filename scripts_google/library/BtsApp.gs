/**
 * BTS Google Sheets automation library.
 *
 * Publish this project as an Apps Script library and include it in spreadsheets
 * under the identifier `BtsApp`. The host spreadsheet only needs lightweight
 * menu wrappers while the automation logic lives here.
 */

var BtsApp = (function () {
  const PROP_PREFIX = 'BTS_AUTOMATION_';
  const PROP_KEYS = {
    baseUrl: `${PROP_PREFIX}BASE_URL`,
    secret: `${PROP_PREFIX}SECRET`,
    iss: `${PROP_PREFIX}ISS`,
    aud: `${PROP_PREFIX}AUD`,
    scopes: `${PROP_PREFIX}SCOPES`,
    sheetInvites: `${PROP_PREFIX}SHEET_INVITES`,
    sheetEventOrders: `${PROP_PREFIX}SHEET_EVENT_ORDERS`
  };
  const DEFAULTS = {
    baseUrl: '',
    secret: '',
    iss: 'google-sheets',
    aud: 'bts-automation',
    scopes: 'automation:jobs:write automation:jobs:run',
    sheetInvites: 'Invitations',
    sheetEventOrders: 'EventOrders',
    renewDryRun: false,
    eventImportDryRun: true,
    renewSubject: 'Renouvellement d’abonnement',
    renewSeasonCode: '2025-2026',
    renewDeadline: '31/08/2025',
    renewProviderLabel: 'HelloAsso'
  };
  const JOB_LOG_SHEET = 'BTS Automations';

  function getProps_() {
    return PropertiesService.getScriptProperties();
  }

  function loadConfig() {
    const props = getProps_().getProperties();
    return {
      baseUrl: props[PROP_KEYS.baseUrl] || DEFAULTS.baseUrl,
      secret: props[PROP_KEYS.secret] || DEFAULTS.secret,
      iss: props[PROP_KEYS.iss] || DEFAULTS.iss,
      aud: props[PROP_KEYS.aud] || DEFAULTS.aud,
      scopes: (props[PROP_KEYS.scopes] || DEFAULTS.scopes).split(/[,\s]+/).filter(Boolean),
      sheetInvites: props[PROP_KEYS.sheetInvites] || DEFAULTS.sheetInvites,
      sheetEventOrders: props[PROP_KEYS.sheetEventOrders] || DEFAULTS.sheetEventOrders
    };
  }

  function ensureConfig() {
    const config = loadConfig();
    if (!config.baseUrl || !config.secret) {
      throw new Error('BTS automation is not configured. Use the Configure action first.');
    }
    return config;
  }

  function saveConfig(config) {
    getProps_().setProperties({
      [PROP_KEYS.baseUrl]: config.baseUrl,
      [PROP_KEYS.secret]: config.secret,
      [PROP_KEYS.iss]: config.iss,
      [PROP_KEYS.aud]: config.aud,
      [PROP_KEYS.scopes]: Array.isArray(config.scopes) ? config.scopes.join(' ') : config.scopes,
      [PROP_KEYS.sheetInvites]: config.sheetInvites,
      [PROP_KEYS.sheetEventOrders]: config.sheetEventOrders
    }, true);
  }

  function base64UrlEncode_(input) {
    let bytes;
    if (Array.isArray(input)) {
      bytes = input;
    } else if (typeof input === 'string') {
      bytes = Utilities.newBlob(input, 'application/octet-stream').getBytes();
    } else {
      throw new Error('Unsupported payload for base64UrlEncode');
    }
    return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
  }

  function createJwt_(config) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode_(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    );
    const payload = base64UrlEncode_(
      JSON.stringify({
        iss: config.iss,
        aud: config.aud,
        iat: now,
        exp: now + 300,
        scopes: config.scopes,
        integration: 'google-sheets',
        requestedBy: Session.getActiveUser()?.getEmail() || 'google-sheets'
      })
    );
    const signingInput = `${header}.${payload}`;
    const signature = base64UrlEncode_(
      Utilities.computeHmacSha256Signature(
        signingInput,
        config.secret,
        Utilities.Charset.UTF_8
      )
    );
    return `${signingInput}.${signature}`;
  }

  function callAutomation(path, payload) {
    const config = ensureConfig();
    const url = `${config.baseUrl.replace(/\/$/, '')}/api/automation/${path.replace(/^\//, '')}`;
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${createJwt_(config)}` },
      muteHttpExceptions: true,
      payload: JSON.stringify(payload)
    });
    if (response.getResponseCode() >= 300) {
      throw new Error(`Automation API ${response.getResponseCode()}: ${response.getContentText()}`);
    }
    return JSON.parse(response.getContentText());
  }

  function collectInvitesFromSheet(sheetName) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }
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

  function toNumber_(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fallback;
    }
    const num = Number(String(value).replace(',', '.'));
    return Number.isFinite(num) ? num : fallback;
  }

  function collectEventOrdersFromSheet(sheetName) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }
    const [headers, ...rows] = sheet.getDataRange().getValues();
    const idx = Object.fromEntries(
      headers.map((name, i) => [String(name).trim().toLowerCase(), i])
    );

    const groups = new Map();

    rows.forEach((row, index) => {
      const getter = (key) => {
        const pos = idx[key];
        if (pos == null) return '';
        return row[pos];
      };

      const payerEmail = String(getter('payeremail') || '').trim();
      const eventSlug = String(getter('eventslug') || '').trim();
      const eventId = String(getter('eventid') || '').trim();
      const zoneKey = String(getter('zonekey') || '').trim();
      const seatId = String(getter('seatid') || '').trim();

      if (!payerEmail || (!eventSlug && !eventId) || (!zoneKey && !seatId)) {
        return;
      }

      const baseKey =
        getter('groupkey') ||
        getter('orderid') ||
        `${payerEmail.toLowerCase()}::${eventSlug || eventId || 'event'}::${index + 1}`;
      const key = String(baseKey).trim();

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          orderId: String(getter('orderid') || '').trim() || null,
          groupKey: String(getter('groupkey') || '').trim() || key,
          eventId: eventId || null,
          eventSlug: eventSlug || null,
          payerEmail,
          payerFirstName: String(getter('payerfirstname') || '').trim(),
          payerLastName: String(getter('payerlastname') || '').trim(),
          seasonCode: String(getter('seasoncode') || '').trim(),
          venueSlug: String(getter('venueslug') || '').trim(),
          status: String(getter('status') || 'paid').trim().toLowerCase(),
          totalCents: toNumber_(getter('totalcents'), null),
          paymentSplit: toNumber_(getter('paymentsplit'), 1),
          createdAt: getter('createdat') || null,
          providerName: String(getter('providername') || '').trim(),
          haOrderId: String(getter('haorderid') || '').trim(),
          checkoutIntentId: String(getter('checkoutintentid') || '').trim(),
          lastReturnCode: String(getter('lastreturncode') || '').trim(),
          lastWebhookEvent: String(getter('lastwebhookevent') || '').trim(),
          attestationSentAt: getter('attestationsentat') || null,
          eventName: String(getter('eventname') || '').trim(),
          eventStartsAt: getter('eventstartsat') || null,
          eventNotes: String(getter('eventnotes') || '').trim(),
          lines: []
        });
      }

      const order = groups.get(key);
      const priceCentsRaw = getter('pricecents');
      let priceCents = toNumber_(priceCentsRaw, NaN);
      if (!Number.isFinite(priceCents) || priceCents <= 0) {
        const priceEuro = getter('priceeuro') || getter('price');
        const euros = toNumber_(priceEuro, NaN);
        if (Number.isFinite(euros) && euros > 0) {
          priceCents = Math.round(euros * 100);
        }
      }
      if (!Number.isFinite(priceCents) || priceCents < 0) {
        priceCents = 0;
      }

      const quantity = Math.max(1, toNumber_(getter('quantity'), 1));

      order.lines.push({
        seatId,
        zoneKey,
        tariffCode: String(getter('tariffcode') || getter('tariff') || '').trim(),
        priceCents,
        quantity,
        holderFirstName: String(getter('holderfirstname') || '').trim(),
        holderLastName: String(getter('holderlastname') || '').trim()
      });
    });

    return Array.from(groups.values()).map((order) => {
      if (!order.totalCents || order.totalCents <= 0) {
        order.totalCents = order.lines.reduce((acc, line) => {
          return acc + Number(line.priceCents || 0) * Number(line.quantity || 1);
        }, 0);
      }
      return order;
    });
  }

  function importEventOrdersFromSheet() {
    try {
      const config = ensureConfig();
      const orders = collectEventOrdersFromSheet(config.sheetEventOrders);
      if (!orders.length) {
        alertInfo('Aucune commande valide détectée (payerEmail + eventSlug + zoneKey).');
        return;
      }
      const response = callAutomation('scripts/event.import-orders/jobs', {
        dryRun: DEFAULTS.eventImportDryRun,
        orders
      });
      appendJobLog({
        scriptId: 'event.import-orders',
        jobId: response.job.id,
        status: response.job.status,
        recordCount: orders.length,
        sheetUrl: SpreadsheetApp.getActive().getUrl()
      });
      alertInfo(`Job ${response.job.id} enregistré (${response.job.status}).`);
    } catch (error) {
      alertError(error);
    }
  }

  function buildRenewJobPayload(invitees) {
    return {
      dryRun: DEFAULTS.renewDryRun,
      params: {
        csv: 'google-sheet',
        template: 'renew-invite',
        subject: DEFAULTS.renewSubject,
        seasonCode: DEFAULTS.renewSeasonCode,
        deadline: DEFAULTS.renewDeadline,
        providerLabel: DEFAULTS.renewProviderLabel,
        invitees
      },
      metadata: {
        source: 'google-sheet',
        sheetUrl: SpreadsheetApp.getActive().getUrl()
      }
    };
  }

  function getOrCreateLogSheet() {
    const ss = SpreadsheetApp.getActive();
    let sheet = ss.getSheetByName(JOB_LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(JOB_LOG_SHEET);
      sheet.appendRow(['Timestamp', 'Script', 'Job ID', 'Status', 'Records', 'Sheet URL']);
    }
    return sheet;
  }

  function appendJobLog(entry) {
    const sheet = getOrCreateLogSheet();
    sheet.appendRow([
      new Date(),
      entry.scriptId,
      entry.jobId,
      entry.status,
      entry.recordCount || '',
      entry.sheetUrl || ''
    ]);
  }

  function getUi_() {
    try {
      return SpreadsheetApp.getUi();
    } catch (error) {
      return null;
    }
  }

  function alertInfo(message) {
    const ui = getUi_();
    if (ui) {
      ui.alert(message);
    } else {
      console.log(message);
    }
  }

  function alertError(err) {
    const message = err && err.message ? err.message : String(err);
    const ui = getUi_();
    if (ui) {
      ui.alert(`Erreur BTS:\n${message}`);
    }
    console.error(err);
  }

  function configureDialog() {
    const ui = SpreadsheetApp.getUi();
    const current = loadConfig();

    const baseUrl = ui.prompt('BTS Base URL (ex: https://bts.example.com/bts)', current.baseUrl, ui.ButtonSet.OK_CANCEL);
    if (baseUrl.getSelectedButton() !== ui.Button.OK) return;

    const secret = ui.prompt('Automation JWT secret', current.secret, ui.ButtonSet.OK_CANCEL);
    if (secret.getSelectedButton() !== ui.Button.OK) return;

    const iss = ui.prompt('JWT issuer (iss)', current.iss, ui.ButtonSet.OK_CANCEL);
    if (iss.getSelectedButton() !== ui.Button.OK) return;

    const aud = ui.prompt('JWT audience (aud)', current.aud, ui.ButtonSet.OK_CANCEL);
    if (aud.getSelectedButton() !== ui.Button.OK) return;

    const scopes = ui.prompt('JWT scopes (séparées par des espaces)', current.scopes.join(' '), ui.ButtonSet.OK_CANCEL);
    if (scopes.getSelectedButton() !== ui.Button.OK) return;

    const sheetInvites = ui.prompt(
      'Nom de l’onglet invitations',
      current.sheetInvites,
      ui.ButtonSet.OK_CANCEL
    );
    if (sheetInvites.getSelectedButton() !== ui.Button.OK) return;

    const sheetEventOrders = ui.prompt(
      'Nom de l’onglet commandes évènementielles',
      current.sheetEventOrders,
      ui.ButtonSet.OK_CANCEL
    );
    if (sheetEventOrders.getSelectedButton() !== ui.Button.OK) return;

    saveConfig({
      baseUrl: baseUrl.getResponseText().trim(),
      secret: secret.getResponseText().trim(),
      iss: iss.getResponseText().trim() || DEFAULTS.iss,
      aud: aud.getResponseText().trim() || DEFAULTS.aud,
      scopes: scopes.getResponseText().trim() || DEFAULTS.scopes,
      sheetInvites: sheetInvites.getResponseText().trim() || DEFAULTS.sheetInvites,
      sheetEventOrders:
        sheetEventOrders.getResponseText().trim() || DEFAULTS.sheetEventOrders
    });

    alertInfo('Configuration BTS enregistrée.');
  }

  function sendRenewInvitesFromSheet() {
    try {
      const config = ensureConfig();
      const invitees = collectInvitesFromSheet(config.sheetInvites);
      if (!invitees.length) {
        alertInfo('Aucune ligne valide (email + renewUrl) détectée.');
        return;
      }
      const payload = buildRenewJobPayload(invitees);
      const response = callAutomation('scripts/season.send-renew-invites/jobs', payload);
      appendJobLog({
        scriptId: 'season.send-renew-invites',
        jobId: response.job.id,
        status: response.job.status,
        recordCount: invitees.length,
        sheetUrl: payload.metadata.sheetUrl
      });
      alertInfo(`Job ${response.job.id} enregistré (${response.job.status}).`);
    } catch (error) {
      alertError(error);
    }
  }

  function getMenuSections() {
    return [
      {
        title: '03 — Season Management',
        items: [{ label: 'Envoyer invitations', handler: 'BTS_sendRenewInvites' }]
      },
      {
        title: '04 — Event Management',
        items: [
          { label: 'Importer commandes (dry-run)', handler: 'BTS_importEventOrders' }
        ]
      }
    ];
  }

  return {
    configure: configureDialog,
    sendRenewInvitesFromSheet,
    importEventOrdersFromSheet,
    getMenuSections
  };
})();
