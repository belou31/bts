/**
 * Shared BTS menu for Google Sheets — registers 02/03/04 sections on open.
 */

const BTS_MENU_ITEMS = {
  '02 — Tariff Management': [
    // Populate with ['Label', 'functionName'] as new sheet automations land.
  ],
  '03 — Season Management': [
    ['Envoyer invitations (dry-run)', 'sendRenewInvitesFromSheet']
  ],
  '04 — Event Management': [
    // Future sheet automations.
  ]
};

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('BTS');
  Object.entries(BTS_MENU_ITEMS).forEach(([section, entries]) => {
    if (!entries.length) return;
    const subMenu = ui.createMenu(section);
    entries.forEach(([label, handler]) => subMenu.addItem(label, handler));
    menu.addSubMenu(subMenu);
  });
  menu.addToUi();
}

