#!/usr/bin/env node
/**
 * Initialize partner customization file with base entries for cseairbus / aisc.
 *
 * Usage:
 *   node scripts/05-partner-management/init-partners.js [--force]
 *
 * The script writes data/customization/partners.json if it doesn't exist
 * (or when --force is passed). You can edit the JSON afterwards to
 * tweak headings, payment modes, messages, etc.
 */

import fs from 'fs';
import path from 'path';
import process from 'process';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');

const targetDir = path.resolve(process.cwd(), 'data', 'customization');
const targetFile = path.join(targetDir, 'partners.json');

const template = [
  {
    slug: 'cseairbus',
    name: 'CSE Airbus',
    paymentMode: 'invoice_auto',
    frameAncestors: [],
    allowedOrigins: [],
    reserve: {
      status: 'paid',
      paymentProvider: 'cseairbus_invoice',
      autoFinalize: true,
      sendTickets: true,
      payButtonLabel: 'Envoyer ma demande',
      successMessage: 'Votre demande a été enregistrée. Vos billets suivront sous peu.',
      errorMessage: 'Impossible d’enregistrer la demande pour le moment.'
    },
    ui: {
      heading: 'Billetterie CSE Airbus',
      lead: 'Choisissez vos places et recevez vos billets automatiquement.',
      paymentHelp: 'La facturation est gérée par le CSE. Aucun paiement en ligne.'
    }
  },
  {
    slug: 'aisc',
    name: 'AISC',
    paymentMode: 'psp',
    frameAncestors: [],
    allowedOrigins: [],
    ui: {
      heading: 'Billetterie AISC',
      lead: 'Offre négociée pour les collaborateurs AISC.',
      paymentHelp: 'Paiement sécurisé via BTS.'
    }
  }
];

fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(targetFile) && !FORCE) {
  console.log(`[partners:init] ${targetFile} already exists. Use --force to overwrite.`);
  process.exit(0);
}

fs.writeFileSync(targetFile, JSON.stringify(template, null, 2), 'utf8');
console.log(`[partners:init] Template written to ${targetFile}`);
console.log('You can edit this file to refine URLs, iframe origins, copy, etc.');
