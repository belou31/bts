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
    sheetConfig: `${PROP_PREFIX}SHEET_CONFIG`,
    renewDryRun: `${PROP_PREFIX}RENEW_DRY_RUN`,
    eventImportDryRun: `${PROP_PREFIX}EVENT_IMPORT_DRY_RUN`,
    eventImportForce: `${PROP_PREFIX}EVENT_IMPORT_FORCE`,
    eventImportSendEmail: `${PROP_PREFIX}EVENT_IMPORT_SEND_EMAIL`,
    sheetInvites: `${PROP_PREFIX}SHEET_INVITES`,
    sheetEventOrders: `${PROP_PREFIX}SHEET_EVENT_ORDERS`,
    sheetTariffCatalog: `${PROP_PREFIX}SHEET_TARIFF_CATALOG`,
    sheetTariffPrices: `${PROP_PREFIX}SHEET_TARIFF_PRICES`,
    tariffCatalogDryRun: `${PROP_PREFIX}TARIFF_CATALOG_DRY_RUN`,
    tariffPricesDryRun: `${PROP_PREFIX}TARIFF_PRICES_DRY_RUN`,
    tariffPricesAppend: `${PROP_PREFIX}TARIFF_PRICES_APPEND`
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
    eventImportForce: false,
    eventImportSendEmail: false,
    renewSubject: 'Renouvellement d’abonnement',
    renewSeasonCode: '2025-2026',
    renewDeadline: '31/08/2025',
    renewProviderLabel: 'HelloAsso',
    sheetConfig: 'BTS_Config',
    sheetTariffCatalog: 'TariffCatalog',
    sheetTariffPrices: 'TariffPrices',
    tariffCatalogDryRun: false,
    tariffPricesDryRun: true,
    tariffPricesAppend: false
  };
  const JOB_LOG_SHEET = 'BTS Automations';

  function getProps_() {
    return PropertiesService.getScriptProperties();
  }

  function loadConfig() {
    const props = getProps_().getProperties();
    const rawScopes = props[PROP_KEYS.scopes] || DEFAULTS.scopes;
    return {
      baseUrl: props[PROP_KEYS.baseUrl] || DEFAULTS.baseUrl,
      secret: props[PROP_KEYS.secret] || DEFAULTS.secret,
      iss: props[PROP_KEYS.iss] || DEFAULTS.iss,
      aud: props[PROP_KEYS.aud] || DEFAULTS.aud,
      scopes: rawScopes.split(/\s+/).filter((token) => token.trim().length > 0),
      sheetInvites: props[PROP_KEYS.sheetInvites] || DEFAULTS.sheetInvites,
      sheetEventOrders: props[PROP_KEYS.sheetEventOrders] || DEFAULTS.sheetEventOrders,
      sheetConfig: props[PROP_KEYS.sheetConfig] || DEFAULTS.sheetConfig,
      sheetTariffCatalog: props[PROP_KEYS.sheetTariffCatalog] || DEFAULTS.sheetTariffCatalog,
      sheetTariffPrices: props[PROP_KEYS.sheetTariffPrices] || DEFAULTS.sheetTariffPrices,
      renewDryRun: parseBooleanConfig(props[PROP_KEYS.renewDryRun], DEFAULTS.renewDryRun),
      eventImportDryRun: parseBooleanConfig(
        props[PROP_KEYS.eventImportDryRun],
        DEFAULTS.eventImportDryRun
      ),
      eventImportForce: parseBooleanConfig(
        props[PROP_KEYS.eventImportForce],
        DEFAULTS.eventImportForce
      ),
      eventImportSendEmail: parseBooleanConfig(
        props[PROP_KEYS.eventImportSendEmail],
        DEFAULTS.eventImportSendEmail
      ),
      tariffCatalogDryRun: parseBooleanConfig(
        props[PROP_KEYS.tariffCatalogDryRun],
        DEFAULTS.tariffCatalogDryRun
      ),
      tariffPricesDryRun: parseBooleanConfig(
        props[PROP_KEYS.tariffPricesDryRun],
        DEFAULTS.tariffPricesDryRun
      ),
      tariffPricesAppend: parseBooleanConfig(
        props[PROP_KEYS.tariffPricesAppend],
        DEFAULTS.tariffPricesAppend
      )
    };
  }

  function ensureConfig() {
    const config = loadConfig();
    const sheetConfig = getSheetConfigMap(config);

    config.baseUrl = config.baseUrl || lookupAny(sheetConfig, ['base.url', 'base_url', 'bts_base_url'], null);
    config.secret = config.secret || lookupAny(sheetConfig, ['automation.secret', 'automation.jwt.secret', 'automation_jwt_secret'], null);
    config.iss = config.iss || lookupAny(sheetConfig, ['jwt.iss', 'automation.jwt.iss', 'automation_jwt_iss'], null) || DEFAULTS.iss;
    config.aud = config.aud || lookupAny(sheetConfig, ['jwt.aud', 'automation.jwt.aud', 'automation_jwt_aud'], null) || DEFAULTS.aud;
    if (!config.scopes || !config.scopes.length) {
      const scopesOverride = lookupAny(sheetConfig, ['jwt.scopes', 'automation.jwt.scopes', 'automation_jwt_scopes'], null);
      config.scopes = scopesOverride
        ? scopesOverride.split(/\s+/).filter((token) => token.trim().length > 0)
        : DEFAULTS.scopes.split(/\s+/).filter((token) => token.trim().length > 0);
    }

    if (!config.baseUrl || !config.secret) {
      throw new Error(
        'BTS automation is not configured. Provide BASE_URL and automation secret via Script Properties or BTS_Config.'
      );
    }

    config._sheetConfig = sheetConfig;
    return config;
  }

  function parseBooleanConfig(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const text = String(value).trim().toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
    return fallback;
  }

  function normalizeCell(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return value.toString();
      return value.toString();
    }
    return String(value).trim();
  }

  function toSlug(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/\s+/g, '').toLowerCase();
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

  function getSheetConfigMap(config) {
    if (config && config._sheetConfig) {
      return config._sheetConfig;
    }
    const sheetName = config.sheetConfig || DEFAULTS.sheetConfig;
    if (!sheetName) return {};
    try {
      const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
      if (!sheet) return {};
      const data = sheet.getDataRange().getValues();
      const map = {};
      data.forEach((row) => {
        if (!row || row.length < 2) return;
        const rawKey = normalizeCell(row[0]);
        if (!rawKey || rawKey.toLowerCase() === 'key') return;
        const key = rawKey.toLowerCase();
        const value = normalizeCell(row[1]);
        map[key] = value;
      });
      if (config) {
        config._sheetConfig = map;
      }
      return map;
    } catch (error) {
      console.warn(`Unable to read config sheet "${sheetName}": ${error}`);
      return {};
    }
  }

  function lookupConfigValue(configMap, key, sheetName) {
    if (!configMap) return '';
    const baseKey = key.toLowerCase();
    const candidates = [];
    if (sheetName) {
      const normalizedSheet = toSlug(sheetName);
      candidates.push(`${baseKey}.${normalizedSheet}`);
    }
    candidates.push(baseKey);
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (configMap[candidate] !== undefined && configMap[candidate] !== '') {
        return configMap[candidate];
      }
    }
    return '';
  }

  function booleanFromConfig(configMap, key, fallback, sheetName) {
    const keys = Array.isArray(key) ? key : [key];
    let override = '';
    for (let i = 0; i < keys.length; i += 1) {
      override = lookupConfigValue(configMap, keys[i], sheetName);
      if (override !== '') break;
    }
    if (override === '') return fallback;
    return parseBooleanConfig(override, fallback);
  }

  function lookupAny(configMap, keys, sheetName) {
    if (!Array.isArray(keys)) return '';
    for (let i = 0; i < keys.length; i += 1) {
      const value = lookupConfigValue(configMap, keys[i], sheetName);
      if (value) return value;
    }
    return '';
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
      const sheetConfig = getSheetConfigMap(config);
      const dryRun = booleanFromConfig(
        sheetConfig,
        ['event.import.dryrun', 'event_import_dry_run', 'bts_event_import_dry_run'],
        config.eventImportDryRun ?? DEFAULTS.eventImportDryRun,
        config.sheetEventOrders
      );
      const force = booleanFromConfig(
        sheetConfig,
        ['event.import.force', 'event_import_force', 'bts_event_import_force'],
        config.eventImportForce ?? DEFAULTS.eventImportForce,
        config.sheetEventOrders
      );
      const sendEmail = booleanFromConfig(
        sheetConfig,
        ['event.import.sendemail', 'event_import_send_email', 'bts_event_import_send_email'],
        config.eventImportSendEmail ?? DEFAULTS.eventImportSendEmail,
        config.sheetEventOrders
      );
      const orders = collectEventOrdersFromSheet(config.sheetEventOrders);
      if (!orders.length) {
        alertInfo('Aucune commande valide détectée (payerEmail + eventSlug + zoneKey).');
        return;
      }
      const payload = {
        dryRun,
        force,
        sendEmail,
        orders,
        metadata: {
          source: 'google-sheet',
          sheetUrl: SpreadsheetApp.getActive().getUrl(),
          sheetName: config.sheetEventOrders,
          configSheet: config.sheetConfig,
          config: sheetConfig,
          configDefaults: {
            dryRun,
            force,
            sendEmail
          }
        }
      };
      const response = callAutomation('scripts/event.import-orders/jobs', payload);
      appendJobLog({
        scriptId: 'event.import-orders',
        jobId: response.job.id,
        status: response.job.status,
        recordCount: orders.length,
        sheetUrl: payload.metadata.sheetUrl
      });
      alertInfo(`Job ${response.job.id} enregistré (${response.job.status}).`);
    } catch (error) {
      alertError(error);
    }
  }

  function buildRenewJobPayload(invitees, config, sheetConfig, dryRun) {
    return {
      dryRun,
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
        sheetUrl: SpreadsheetApp.getActive().getUrl(),
        configSheet: config.sheetConfig,
        config: sheetConfig
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

  function sendRenewInvitesFromSheet() {
    try {
      const config = ensureConfig();
      const sheetConfig = getSheetConfigMap(config);
      const dryRun = booleanFromConfig(
        sheetConfig,
        ['renew.dryrun', 'renew_dry_run', 'bts_renew_dry_run'],
        config.renewDryRun ?? DEFAULTS.renewDryRun,
        config.sheetInvites
      );
      const invitees = collectInvitesFromSheet(config.sheetInvites);
      if (!invitees.length) {
        alertInfo('Aucune ligne valide (email + renewUrl) détectée.');
        return;
      }
      const payload = buildRenewJobPayload(invitees, config, sheetConfig, dryRun);
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

  function collectTariffCatalogFromSheet(sheetName) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }
    const data = sheet.getDataRange().getValues();
    if (!data.length) return [];

    const headers = data[0].map((value) => normalizeCell(value).toLowerCase());
    const index = Object.fromEntries(headers.map((name, i) => [name, i]));

    const entries = [];
    for (let rowIdx = 1; rowIdx < data.length; rowIdx += 1) {
      const row = data[rowIdx];
      const getValue = (key) => {
        const pos = index[key];
        if (pos == null) return '';
        return normalizeCell(row[pos]);
      };
      const code = getValue('code').toUpperCase();
      const label = getValue('label');
      if (!code || !label) continue;

      entries.push({
        code,
        label,
        requiresField: getValue('requiresfield') || getValue('requires_field'),
        fieldLabel: getValue('fieldlabel') || getValue('field_label'),
        requiresInfo: getValue('requiresinfo') || getValue('requires_info'),
        active: parseBooleanConfig(getValue('active') || getValue('enabled'), true),
        sortOrder: getValue('sortorder') || getValue('sort_order')
      });
    }
    return entries;
  }

  function collectTariffPricesFromSheet(sheetName, defaults) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }
    const data = sheet.getDataRange().getValues();
    if (!data.length) return [];

    const headers = data[0].map((value) => normalizeCell(value).toLowerCase());
    const index = Object.fromEntries(headers.map((name, i) => [name, i]));

    const entries = [];
    for (let rowIdx = 1; rowIdx < data.length; rowIdx += 1) {
      const row = data[rowIdx];
      const getValue = (key) => {
        const pos = index[key];
        if (pos == null) return '';
        return normalizeCell(row[pos]);
      };
      let catalogSlug = (getValue('catalogslug') || getValue('catalog')).toLowerCase();
      if (!catalogSlug && defaults.catalogSlug) {
        catalogSlug = defaults.catalogSlug.toLowerCase();
      }
      const zoneKey = (getValue('zonekey') || getValue('zone')).toUpperCase();
      const tariffCode = (getValue('tariffcode') || getValue('tariff') || getValue('code')).toUpperCase();
      if (!catalogSlug || !zoneKey || !tariffCode) continue;

      const priceCents = toNumber_(getValue('pricecents'), NaN);
      const priceEuro = toNumber_(getValue('priceeuro') || getValue('price'), NaN);

      entries.push({
        catalogSlug: catalogSlug || defaults.catalogSlug || '',
        venueSlug: getValue('venueslug') || defaults.venueSlug || '',
        zoneKey,
        tariffCode,
        priceCents: Number.isFinite(priceCents) ? Math.round(priceCents) : '',
        priceEuro: Number.isFinite(priceEuro) ? priceEuro : '',
        currency: getValue('currency') || 'EUR'
      });
    }
    return entries;
  }

  function importTariffCatalogFromSheet() {
    try {
      const config = ensureConfig();
      const sheetConfig = getSheetConfigMap(config);
      const entries = collectTariffCatalogFromSheet(config.sheetTariffCatalog);
      if (!entries.length) {
        alertInfo('Aucune ligne valide (code + label) détectée.');
        return;
      }
      const dryRun = booleanFromConfig(
        sheetConfig,
        ['tariff.catalog.dryrun', 'tariff_catalog_dry_run', 'bts_tariff_catalog_dry_run'],
        config.tariffCatalogDryRun ?? DEFAULTS.tariffCatalogDryRun,
        config.sheetTariffCatalog
      );
      const payload = {
        dryRun,
        entries,
        metadata: {
          source: 'google-sheet',
          sheetUrl: SpreadsheetApp.getActive().getUrl(),
          sheetName: config.sheetTariffCatalog,
          configSheet: config.sheetConfig,
          config: sheetConfig,
          configDefaults: {
            dryRun
          }
        }
      };
      const response = callAutomation('scripts/tariff.import-catalog/jobs', payload);
      appendJobLog({
        scriptId: 'tariff.import-catalog',
        jobId: response.job.id,
        status: response.job.status,
        recordCount: entries.length,
        sheetUrl: payload.metadata.sheetUrl
      });
      alertInfo(`Job ${response.job.id} enregistré (${response.job.status}).`);
    } catch (error) {
      alertError(error);
    }
  }

  function importTariffPricesFromSheet() {
    try {
      const config = ensureConfig();
      const sheetConfig = getSheetConfigMap(config);
      const defaults = {
        catalogSlug: lookupConfigValue(sheetConfig, 'tariff.prices.slug', config.sheetTariffPrices),
        venueSlug: lookupConfigValue(sheetConfig, 'tariff.prices.venue', config.sheetTariffPrices)
      };
      const entries = collectTariffPricesFromSheet(config.sheetTariffPrices, defaults);
      if (!entries.length) {
        alertInfo('Aucune ligne valide (catalogSlug + zoneKey + tariffCode + prix) détectée.');
        return;
      }
      const dryRun = booleanFromConfig(
        sheetConfig,
        ['tariff.prices.dryrun', 'tariff_prices_dry_run', 'bts_tariff_prices_dry_run'],
        config.tariffPricesDryRun ?? DEFAULTS.tariffPricesDryRun,
        config.sheetTariffPrices
      );
      const append = booleanFromConfig(
        sheetConfig,
        ['tariff.prices.append', 'tariff_prices_append', 'bts_tariff_prices_append'],
        config.tariffPricesAppend ?? DEFAULTS.tariffPricesAppend,
        config.sheetTariffPrices
      );
      const payload = {
        dryRun,
        append,
        catalogSlug: defaults.catalogSlug || '',
        venueSlug: defaults.venueSlug || '',
        entries,
        metadata: {
          source: 'google-sheet',
          sheetUrl: SpreadsheetApp.getActive().getUrl(),
          sheetName: config.sheetTariffPrices,
          configSheet: config.sheetConfig,
          configDefaults: {
            ...defaults,
            dryRun,
            append
          },
          config: sheetConfig
        }
      };
      const response = callAutomation('scripts/tariff.import-prices/jobs', payload);
      appendJobLog({
        scriptId: 'tariff.import-prices',
        jobId: response.job.id,
        status: response.job.status,
        recordCount: entries.length,
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
        title: '02 — Tariff Management',
        items: [
          { label: 'Importer catalogue tarifs', handler: 'importTariffCatalogFromSheet' },
          { label: 'Importer catalogue prix', handler: 'importTariffPricesFromSheet' }
        ]
      },
      {
        title: '03 — Season Management',
        items: [{ label: 'Envoyer invitations', handler: 'sendRenewInvitesFromSheet' }]
      },
      {
        title: '04 — Event Management',
        items: [
          { label: 'Importer commandes (dry-run)', handler: 'importEventOrdersFromSheet' }
        ]
      }
    ];
  }

  function createMenu(libraryId) {
    const ui = SpreadsheetApp.getUi();
    const menu = ui.createMenu('BTS');

    getMenuSections().forEach((section) => {
      const sub = ui.createMenu(section.title);
      section.items.forEach((item) => {
        const handlerPath = `${libraryId}.${item.handler}`;
        sub.addItem(item.label, handlerPath);
      });
      menu.addSubMenu(sub);
    });

    menu.addToUi();
  }

  return {
    sendRenewInvitesFromSheet,
    importEventOrdersFromSheet,
    importTariffCatalogFromSheet,
    importTariffPricesFromSheet,
    getMenuSections,
    createMenu
  };
})();

function createMenu(libraryId) {
  if (typeof BtsApp?.createMenu === 'function') {
    BtsApp.createMenu(libraryId);
  }
}
