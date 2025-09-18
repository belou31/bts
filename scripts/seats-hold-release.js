#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { connectMongo, readCsv, logDryRun } from './_utils.js';
import { SeatHold } from '../src/models/SeatHold.js';

const argv = yargs(hideBin(process.argv))
  .option('file',  { type: 'string', demandOption: true })
  .option('force', { type: 'boolean', default: false, desc: 'forcer le blocage/libération' })
  .option('commit',{ type: 'boolean', default: false })
  .argv;

(async () => {
  await connectMongo();
  logDryRun(argv.commit);

  const rows = await readCsv(argv.file);
  let blocked = 0, freed = 0;

  for (const r of rows) {
    const action = (r.action || '').toLowerCase(); // block | free
    const q = {
      eventId: r.eventId,
      ...(r.seatId ? { seatId: r.seatId } : {}),
      ...(r.zoneKey ? { zoneKey: r.zoneKey } : {}),
    };

    if (action === 'block') {
      const doc = {
        ...q,
        reason: r.reason || '',
        expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
        forced: !!argv.force,
      };
      if (!argv.commit) {
        console.log('🧪 BLOCK', doc);
        continue;
      }
      // si --force, on remplace les holds existants sinon on upsert si absent
      await SeatHold.findOneAndUpdate(q, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
      blocked++;
    } else if (action === 'free') {
      if (!argv.commit) {
        console.log('🧪 FREE', q);
        continue;
      }
      // si --force on supprime même si expiré/non-expiré; sinon suppression standard
      await SeatHold.deleteMany(q);
      freed++;
    } else {
      console.warn('⏭️  action inconnue:', action);
    }
  }

  console.log(`✅ Blocked: ${blocked} | Freed: ${freed}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
