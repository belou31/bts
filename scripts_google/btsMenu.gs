function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const menu = ui.createMenu('BTS');
  BtsLib.BtsApp.getMenuSections().forEach((section) => {
    const sub = ui.createMenu(section.title);
    section.items.forEach((item) => sub.addItem(item.label, item.handler));
    menu.addSubMenu(sub);
  });
  menu.addSeparator();
  menu.addItem('Configure…', 'BTS_configure');
  menu.addToUi();
}

function BTS_configure() {
  BtsLib.BtsApp.configure();
}

function BTS_sendRenewInvites() {
  BtsLib.BtsApp.sendRenewInvitesFromSheet();
}

function BTS_importEventOrders() {
  BtsLib.BtsApp.importEventOrdersFromSheet();
}
