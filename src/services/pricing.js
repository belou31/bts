
import { Seat } from '../models/Seat.js';
import { Zone } from '../models/Zone.js';
import { PriceTable } from '../models/PriceTable.js';


async function resolveZoneKey(seasonCode, seatId, zoneKey) {
  if (zoneKey) return zoneKey;
  const seat = await Seat.findOne({ seatId, seasonCode });
  if (!seat) throw Object.assign(new Error(`Seat ${seatId} not found for ${seasonCode}`), { status: 400 });
  return seat.zoneKey;
}

async function getPriceFor({ seasonCode, seatId=null, zoneKey=null, tariffCode='ADULT', context=null }) {
  const zk = await resolveZoneKey(seasonCode, seatId, zoneKey);
  const zone = await Zone.findOne({ key: zk, seasonCode, isActive: true });
  if (!zone) throw Object.assign(new Error(`Zone ${zk} not found`), { status: 400 });

  const table = await PriceTable.findOne({ seasonCode, zoneKey: zk });
  if (!table) throw Object.assign(new Error(`No price table for zone ${zk}`), { status: 400 });

  const p = table.prices.find(x => x.code === tariffCode);
  if (!p) throw Object.assign(new Error(`Unknown tariff ${tariffCode} for zone ${zk}`), { status: 400 });

  let amount = p.amountCents;

  // Fanclub discount (TBH7) s'il y a un rabais défini sur la zone
  if (zone.type === 'fanclub' && (context === 'tbh7' || context === 'TBH7')) {
    const pct = zone.fanclubDiscountPct || 0.30;
    amount = Math.round(amount * (1 - pct));
  }

  return { unitPriceCents: amount, requiresJustification: !!p.requiresJustification, zone, table };
}

export { getPriceFor };
