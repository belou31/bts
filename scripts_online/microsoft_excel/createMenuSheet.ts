/**
 * Office Script — Create/refresh a "BTS Menu" worksheet listing available scripts.
 *
 * Excel Online does not support programmatic ribbon customization for Office Scripts,
 * so this sheet acts as a lightweight menu with descriptions of each automation.
 */

type MenuEntry = {
  label: string;
  scriptName: string;
  description: string;
};

const MENU_SHEET_NAME = 'BTS Menu';

function main(workbook: ExcelScript.Workbook) {
  const entries: MenuEntry[] = [
    {
      label: 'Configure BTS settings',
      scriptName: 'ConfigureBts',
      description: 'Initialise BASE_URL, secrets et paramètres par feuille.'
    },
    {
      label: 'Envoyer invitations (renouvellement)',
      scriptName: 'SendRenewInvites',
      description: 'Lit la feuille "Invitations" et poste les invites à season.send-renew-invites.'
    },
    {
      label: 'Importer commandes évènement (dry-run par défaut)',
      scriptName: 'ImportEventOrders',
      description: 'Lit la feuille "EventOrders" et poste les commandes à event.import-orders.'
    }
  ];

  let sheet = workbook.getWorksheet(MENU_SHEET_NAME);
  if (sheet) {
    sheet.getUsedRange()?.clear();
  } else {
    sheet = workbook.addWorksheet(MENU_SHEET_NAME);
  }

  sheet.getRange('A1:C1').setValues([['Action', 'Script', 'Description']]);
  sheet.getRange('A1:C1').getFormat().getFill().setColor('#1f497d');
  sheet.getRange('A1:C1').getFormat().getFont().setColor('#FFFFFF');
  sheet.getRange('A1:C1').getFormat().getFont().setBold(true);

  const rows = entries.map((entry) => [entry.label, entry.scriptName, entry.description]);
  if (rows.length) {
    sheet.getRangeByIndexes(1, 0, rows.length, 3).setValues(rows);
  }

  sheet.getRange('A:C').getFormat().setColumnWidth(0, 260);
  sheet.getRange('A:C').getFormat().setColumnWidth(1, 200);
  sheet.getRange('A:C').getFormat().setColumnWidth(2, 420);
  sheet.activate();
}
