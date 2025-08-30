// scripts/seed-dev.js

import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';

import { Season } from '../../src/models/Season.js';
import { Zone } from '../../src/models/Zone.js';
import { Seat } from '../../src/models/Seat.js';
import { PriceTable } from '../../src/models/PriceTable.js';
import { Campaign } from '../../src/models/Campaign.js';

import dotenv from 'dotenv';
dotenv.config();


async function upsert(model, where, data) {
  return model.findOneAndUpdate(where, { $set: data }, { upsert: true, new: true });
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGO_URI/MONGODB_URI manquant dans .env');
  await mongoose.connect(uri);
  console.log('[seed] Connected');

  // 1) Saison + phases
  const seasonCode = '2025-2026';
  const now = new Date();
  const in30 = new Date(Date.now() + 30*24*60*60*1000);
  const in60 = new Date(Date.now() + 60*24*60*60*1000);

  await upsert(Season, { code: seasonCode }, {
    code: seasonCode,
    name: 'Saison 2025-2026',
    active: true,
    phases: [
      { name: 'renewal', openAt: now, closeAt: in30, enabled: true },
      { name: 'tbh7',    openAt: now, closeAt: in60, enabled: true },
      { name: 'public',  openAt: in30, closeAt: null, enabled: true },
    ]
  });
  console.log('[seed] Season ok');

  // 2) Zones
  const zones = [
    { key:'A1', name:'Tribune A1', type:'seated', basePriceCents: 18000, quota: 100, seasonCode, isActive:true },
    { key:'A2', name:'Tribune A2', type:'seated', basePriceCents: 16000, quota: 100, seasonCode, isActive:true },
    { key:'DEBOUT', name:'Debout', type:'standing', capacity: 500, basePriceCents: 9000, quota: 500, seasonCode, isActive:true },
    { key:'TBH7_NORD', name:'TBH7 Nord', type:'fanclub', capacity: 80, basePriceCents: 14000, fanclubDiscountPct: 0.30, quota: 80, seasonCode, isActive:true },
    { key:'TBH7_SUD',  name:'TBH7 Sud',  type:'fanclub', capacity: 80, basePriceCents: 14000, fanclubDiscountPct: 0.30, quota: 80, seasonCode, isActive:true },
  ];
  for (const z of zones) await upsert(Zone, { key: z.key, seasonCode }, z);
  console.log('[seed] Zones ok');

  // 3) Sièges (quelques exemples qui existent dans src/public/static/arena.svg)
  const seats = [
    { seatId:'A1-001', zoneKey:'A1', seasonCode, status:'available' },
    { seatId:'A1-002', zoneKey:'A1', seasonCode, status:'available' },
    { seatId:'A1-003', zoneKey:'A1', seasonCode, status:'available' },
  ];
  for (const s of seats) await upsert(Seat, { seatId: s.seatId }, s);
  console.log('[seed] Seats ok');

  // 4) Tarifs (par zone)
  const commonPrices = [
    { code:'ADULT', label:'Adulte', amountCents: 0, requiresJustification:false },
    { code:'TEEN_12_18', label:'12–18 ans', amountCents: 0, requiresJustification:true },
    { code:'CHILD', label:'Enfant', amountCents: 0, requiresJustification:true },
    { code:'STUDENT', label:'Étudiant', amountCents: 0, requiresJustification:true },
    { code:'SENIOR', label:'Senior', amountCents: 0, requiresJustification:true },
  ];
  const priceTables = [
    { zoneKey:'A1',     base:18000 },
    { zoneKey:'A2',     base:16000 },
    { zoneKey:'DEBOUT', base: 9000 },
    { zoneKey:'TBH7_NORD', base:14000 },
    { zoneKey:'TBH7_SUD',  base:14000 },
  ];

  for (const pt of priceTables) {
    const prices = commonPrices.map(p => ({
      ...p,
      amountCents: Math.round(
        (pt.base) *
        (['TEEN_12_18','CHILD','STUDENT','SENIOR'].includes(p.code) ? 0.75 : 1.00)
      )
    }));
    await upsert(PriceTable, { seasonCode, zoneKey: pt.zoneKey }, { seasonCode, zoneKey: pt.zoneKey, prices });
  }
  console.log('[seed] Prices ok');

  // 5) Campagne TBH7
  await upsert(Campaign, { code:`TBH7-${seasonCode.split('-')[0]}`, phase:'tbh7' }, {
    code:`TBH7-${seasonCode.split('-')[0]}`,
    phase:'tbh7',
    seasonCode,
    maxUses: 0,
    used: 0,
    meta: { contact:'tbh7@belougas.fr' }
  });
  console.log('[seed] Campaign TBH7 ok');

  await mongoose.disconnect();
  console.log('[seed] Done');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
