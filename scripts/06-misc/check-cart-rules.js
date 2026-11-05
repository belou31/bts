#!/usr/bin/env node
//
// Contrôles de panier (src/services/cart-rules.js) : canaux, seuils, tranches
// « per », et refus d'une configuration mal formée. Sans base ni .env.
//
//   npm run test:cart-rules
import { normalizeCartRules, rulesForChannel, cartRuleViolation } from '../../src/services/cart-rules.js';

let failures = 0;
const check = (label, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ ÉCHEC\x1b[0m'} ${label}${detail ? '  — ' + detail : ''}`);
};
const lines = (spec) => Object.entries(spec).flatMap(([t, n]) => Array.from({ length: n }, () => ({ tariffCode: t })));

const rules = normalizeCartRules([
  { key: 'enfant', message: 'Un adulte requis', when: { tariffs: ['enfant'] }, require: { tariffs: ['NORMAL', 'AISC'] } },
  { key: 'ratio', channels: ['partner:aisc'], when: { tariffs: ['ENFANT'] }, require: { tariffs: ['NORMAL', 'AISC'], per: 4 } },
  { key: 'tous-partenaires', channels: ['partner'], when: { tariffs: ['INVITE'] }, require: { tariffs: ['AISC'], min: 1 } }
]);

console.log('\n\x1b[1m1. Canaux\x1b[0m');
const pub = rulesForChannel(rules, 'public');
const aisc = rulesForChannel(rules, 'partner:aisc');
const other = rulesForChannel(rules, 'partner:autre');
check('public : seulement les règles sans canal', pub.map(r => r.key).join() === 'enfant', pub.map(r => r.key).join());
check('partner:aisc : règle exacte + « partner »', aisc.map(r => r.key).join() === 'enfant,ratio,tous-partenaires');
check('autre partenaire : pas la règle aisc', other.map(r => r.key).join() === 'enfant,tous-partenaires');

console.log('\n\x1b[1m2. Seuils\x1b[0m');
check('panier sans enfant : rien à contrôler', cartRuleViolation(pub, lines({ NORMAL: 2 })) === null);
check('enfant seul : refusé', cartRuleViolation(pub, lines({ ENFANT: 1 }))?.key === 'enfant');
check('enfant + adulte : accepté', cartRuleViolation(pub, lines({ ENFANT: 3, NORMAL: 1 })) === null);
check('codes insensibles à la casse', cartRuleViolation(pub, [{ tariffCode: 'enfant' }, { tariffCode: 'normal' }]) === null);
const r5 = cartRuleViolation(aisc, lines({ ENFANT: 5, AISC: 1 }));
check('per 4 : 5 enfants demandent 2 adultes', r5?.key === 'ratio' && r5.needed === 2 && r5.have === 1, JSON.stringify(r5));
check('per 4 : 4 enfants + 1 adulte acceptés', cartRuleViolation(aisc, lines({ ENFANT: 4, AISC: 1 })) === null);

console.log('\n\x1b[1m3. Configuration mal formée\x1b[0m');
for (const [label, bad, re] of [
  ['when vide', [{ key: 'x', when: { tariffs: [] }, require: { tariffs: ['A'] } }], /when\.tariffs vide/],
  ['require vide', [{ key: 'x', when: { tariffs: ['A'] }, require: {} }], /require\.tariffs vide/],
  ['min 0', [{ key: 'x', when: { tariffs: ['A'] }, require: { tariffs: ['B'], min: 0 } }], /require\.min/],
  ['pas un tableau', { key: 'x' }, /tableau/]
]) {
  let msg = '';
  try { normalizeCartRules(bad); } catch (e) { msg = e.message; }
  check(`${label} → erreur explicite`, re.test(msg), msg);
}

console.log(failures ? `\n\x1b[31m${failures} contrôle(s) en échec.\x1b[0m` : '\n\x1b[32mTous les contrôles passent.\x1b[0m');
process.exit(failures ? 1 : 0);
