#!/usr/bin/env node
//
// Éprouve le plafond ORDER_MAX_ITEMS sur chaque flux en libre-service, sans
// base de données : seules les gardes de comptage sont en jeu, et les monter
// contre un vrai mongo n'apprendrait rien de plus sur elles.
//
//   npm run test:order-limits
//
// Ne touche aucun fichier.
import assert from 'node:assert/strict';

const ok = (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ ÉCHEC\x1b[0m');
let failures = 0;
function check(label, pass, detail = '') {
  if (!pass) failures++;
  console.log(`  ${ok(pass)} ${label}${detail ? '  — ' + detail : ''}`);
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seatId: `S-${i}`, zoneKey: 'A' }));

process.env.ORDER_MAX_ITEMS = '19';
const lim = await import('../../src/config/order-limits.js');

console.log('\n\x1b[1m1. Lecture du réglage\x1b[0m');
check('ORDER_MAX_ITEMS=19 pris en compte', lim.orderMaxItems() === 19, String(lim.orderMaxItems()));
check('défaut du code = 19', lim.ORDER_MAX_ITEMS_DEFAULT === 19);

console.log('\n\x1b[1m2. Frontière\x1b[0m');
check('19 places acceptées', lim.orderItemsRefusal(19) === null);
check('20 places refusées', lim.orderItemsRefusal(20)?.error === 'too_many_items');
const r = lim.orderItemsRefusal(25);
check('le refus dit le plafond et le demandé', r.max === 19 && r.asked === 25, `max=${r.max} asked=${r.asked}`);
check('le refus porte un message lisible', /25 places/.test(r.message) && /19/.test(r.message));

console.log('\n\x1b[1m3. Décompte des places\x1b[0m');
check('une ligne = une place', lim.countPlaces(seats(7)) === 7);
check('qty d\'une commande importée respecté',
  lim.countPlaces([{ qty: 4 }, { quantity: 3 }, {}]) === 8, String(lim.countPlaces([{ qty: 4 }, { quantity: 3 }, {}])));
check('panier vide = 0', lim.countPlaces([]) === 0 && lim.countPlaces(null) === 0);

console.log('\n\x1b[1m4. Variante à lever (flux événement)\x1b[0m');
let thrown = null;
try { lim.assertOrderItemCount(20); } catch (e) { thrown = e; }
check('lève au-delà du plafond', !!thrown);
check('l\'erreur porte le corps de refus',
  thrown?.refusal?.error === 'too_many_items' && thrown.refusal.max === 19);
assert.doesNotThrow(() => lim.assertOrderItemCount(19));
check('ne lève pas à la frontière', true);

console.log('\n\x1b[1m5. Échappatoire et valeur illisible\x1b[0m');
process.env.ORDER_MAX_ITEMS = '0';
check('0 = aucun plafond', lim.orderMaxItems() === 0 && lim.orderItemsRefusal(500) === null);
process.env.ORDER_MAX_ITEMS = '5';
check('une autre valeur est suivie', lim.orderItemsRefusal(6)?.max === 5);
process.env.ORDER_MAX_ITEMS = '-3';
check('valeur négative → défaut, avec avertissement', lim.orderMaxItems() === 19);
delete process.env.ORDER_MAX_ITEMS;
check('variable absente → défaut', lim.orderMaxItems() === 19);

console.log('\n\x1b[1m6. Achat de bons : le plus bas des deux réglages\x1b[0m');
// voucher-purchase.json porte son propre maxPlaces ; le plafond global ne doit
// pas pouvoir être contourné par le haut, ni écraser un maximum plus strict.
// On appelle la fonction DONT SE SERT la route, pas une copie de sa règle.
process.env.ORDER_MAX_ITEMS = '19';
check('maxPlaces=10 conservé (plus strict)', lim.effectiveMaxPlaces(10) === 10);
check('maxPlaces=50 ramené à 19', lim.effectiveMaxPlaces(50) === 19);
process.env.ORDER_MAX_ITEMS = '0';
check('plafond désactivé → maxPlaces seul', lim.effectiveMaxPlaces(50) === 50);
process.env.ORDER_MAX_ITEMS = '19';
check('maxPlaces absent → plafond global', lim.effectiveMaxPlaces(0) === 19);

console.log(failures === 0
  ? '\n\x1b[32mTous les contrôles passent.\x1b[0m'
  : `\n\x1b[31m${failures} contrôle(s) en échec.\x1b[0m`);
process.exit(failures ? 1 : 0);
