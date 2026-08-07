/**
 * Office Script — Configure BTS automation settings.
 *
 * Usage:
 *   Run from Excel Online (Automate tab) and provide the desired parameters.
 *   Any parameter left blank keeps the previous value.
 *
 * Stored keys (column A) inside the worksheet `BTS_Config`:
 *   BASE_URL, AUTOMATION_SECRET, ISSUER, AUDIENCE, SCOPES,
 *   INVITES_SHEET, EVENT_ORDERS_SHEET, TARIFF_CATALOG_SHEET, TARIFF_PRICES_SHEET,
 *   RENEW_DRY_RUN, EVENT_IMPORT_DRY_RUN, EVENT_IMPORT_FORCE, EVENT_IMPORT_SEND_EMAIL,
 *   TARIFF_CATALOG_DRY_RUN, TARIFF_PRICES_DRY_RUN, TARIFF_PRICES_APPEND
 *
 * Dotted aliases (e.g. `tariff.prices.dryRun`) are also recognised for interoperability
 * with Google Sheets / LibreOffice helpers.
*/

type ConfigureArgs = {
  baseUrl?: string;
  secret?: string;
  issuer?: string;
  audience?: string;
  scopes?: string;
  invitesSheet?: string;
  eventOrdersSheet?: string;
  renewDryRun?: string;
  eventImportDryRun?: string;
  eventImportForce?: string;
  eventImportSendEmail?: string;
  tariffCatalogSheet?: string;
  tariffPricesSheet?: string;
  tariffCatalogDryRun?: string;
  tariffPricesDryRun?: string;
  tariffPricesAppend?: string;
};

const CONFIG_SHEET_NAME = 'BTS_Config';

function normalizeBool(value: string | undefined, fallback: string): string {
  if (!value || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized) ? 'true' : 'false';
}

function main(workbook: ExcelScript.Workbook, args?: ConfigureArgs) {
  const defaults: Record<string, string> = {
    BASE_URL: '',
    AUTOMATION_SECRET: '',
    ISSUER: 'excel-online',
    AUDIENCE: 'bts-automation',
    SCOPES: 'automation:jobs:write automation:jobs:run automation:events:write',
    INVITES_SHEET: 'Invitations',
    EVENT_ORDERS_SHEET: 'EventOrders',
    TARIFF_CATALOG_SHEET: 'TariffCatalog',
    TARIFF_PRICES_SHEET: 'TariffPrices',
    RENEW_DRY_RUN: 'false',
    EVENT_IMPORT_DRY_RUN: 'true',
    EVENT_IMPORT_FORCE: 'false',
    EVENT_IMPORT_SEND_EMAIL: 'false',
    TARIFF_CATALOG_DRY_RUN: 'false',
    TARIFF_PRICES_DRY_RUN: 'true',
    TARIFF_PRICES_APPEND: 'false'
  };

  const current = readConfigSheet(workbook, defaults);

  const updates: Record<string, string> = { ...current };
  if (args?.baseUrl !== undefined) updates.BASE_URL = args.baseUrl.trim();
  if (args?.secret !== undefined) updates.AUTOMATION_SECRET = args.secret.trim();
  if (args?.issuer !== undefined) updates.ISSUER = args.issuer.trim() || defaults.ISSUER;
  if (args?.audience !== undefined) updates.AUDIENCE = args.audience.trim() || defaults.AUDIENCE;
  if (args?.scopes !== undefined) updates.SCOPES = args.scopes.trim() || defaults.SCOPES;
  if (args?.invitesSheet !== undefined) updates.INVITES_SHEET = args.invitesSheet.trim() || defaults.INVITES_SHEET;
  if (args?.eventOrdersSheet !== undefined) {
    updates.EVENT_ORDERS_SHEET = args.eventOrdersSheet.trim() || defaults.EVENT_ORDERS_SHEET;
  }
  if (args?.tariffCatalogSheet !== undefined) {
    updates.TARIFF_CATALOG_SHEET =
      args.tariffCatalogSheet.trim() || defaults.TARIFF_CATALOG_SHEET;
  }
  if (args?.tariffPricesSheet !== undefined) {
    updates.TARIFF_PRICES_SHEET = args.tariffPricesSheet.trim() || defaults.TARIFF_PRICES_SHEET;
  }
  if (args?.renewDryRun !== undefined) {
    updates.RENEW_DRY_RUN = normalizeBool(args.renewDryRun, updates.RENEW_DRY_RUN);
  }
  if (args?.eventImportDryRun !== undefined) {
    updates.EVENT_IMPORT_DRY_RUN = normalizeBool(
      args.eventImportDryRun,
      updates.EVENT_IMPORT_DRY_RUN
    );
  }
  if (args?.eventImportForce !== undefined) {
    updates.EVENT_IMPORT_FORCE = normalizeBool(
      args.eventImportForce,
      updates.EVENT_IMPORT_FORCE
    );
  }
  if (args?.eventImportSendEmail !== undefined) {
    updates.EVENT_IMPORT_SEND_EMAIL = normalizeBool(
      args.eventImportSendEmail,
      updates.EVENT_IMPORT_SEND_EMAIL
    );
  }
  if (args?.tariffCatalogDryRun !== undefined) {
    updates.TARIFF_CATALOG_DRY_RUN = normalizeBool(
      args.tariffCatalogDryRun,
      updates.TARIFF_CATALOG_DRY_RUN
    );
  }
  if (args?.tariffPricesDryRun !== undefined) {
    updates.TARIFF_PRICES_DRY_RUN = normalizeBool(
      args.tariffPricesDryRun,
      updates.TARIFF_PRICES_DRY_RUN
    );
  }
  if (args?.tariffPricesAppend !== undefined) {
    updates.TARIFF_PRICES_APPEND = normalizeBool(
      args.tariffPricesAppend,
      updates.TARIFF_PRICES_APPEND
    );
  }

  writeConfigSheet(workbook, updates);
}

function readConfigSheet(
  workbook: ExcelScript.Workbook,
  defaults: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = { ...defaults };
  let sheet = workbook.getWorksheet(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = workbook.addWorksheet(CONFIG_SHEET_NAME);
    sheet.getRange('A1').setValue('KEY');
    sheet.getRange('B1').setValue('VALUE');
    return result;
  }

  const range = sheet.getUsedRange();
  if (!range) return result;
  const values = range.getValues() as (string | number | boolean)[][];
  for (let r = 1; r < values.length; r++) {
    const keyRaw = values[r][0];
    const valueRaw = values[r][1];
    if (!keyRaw) continue;
    const rawKey = String(keyRaw).trim();
    if (!rawKey) continue;
    const value = valueRaw === undefined ? '' : String(valueRaw);
    const canonicalUpper = rawKey.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
    result[canonicalUpper] = value;
    const lowerKey = rawKey.toLowerCase();
    result[lowerKey] = value;
  }
  return result;
}

function writeConfigSheet(workbook: ExcelScript.Workbook, config: Record<string, string>) {
  let sheet = workbook.getWorksheet(CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = workbook.addWorksheet(CONFIG_SHEET_NAME);
  }
  const entries = Object.entries(config);
  const values: (string | number | boolean)[][] = [['KEY', 'VALUE']];
  entries.forEach(([key, value]) => {
    values.push([key, value]);
  });
  const range = sheet.getRangeByIndexes(0, 0, values.length, 2);
  range.setValues(values);
  range.getFormat().setColumnWidth(0, 200);
  range.getFormat().setColumnWidth(1, 350);
  sheet.getRange('B:B').setNumberFormatLocal('@');
}
