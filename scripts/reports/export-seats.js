// scripts/reports/export-seats.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { exportSeatsCsv } from '../../src/services/exports.js';

dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI manquant'); process.exit(1); }

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue=')) ?.split('=')[1] || null;
const zone   = process.argv.find(a => a.startsWith('--zone='))  ?.split('=')[1] || null;

const filterSeat  = {};
const filterOrder = {};
if (season) { filterSeat.seasonCode = season; filterOrder.seasonCode = season; }
if (venue)  { filterSeat.venueSlug  = venue;  filterOrder.venueSlug  = venue;  }
if (zone)   { filterSeat.zoneKey    = zone; }

await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
await exportSeatsCsv({ out: process.stdout, filterSeat, filterOrder, includeHeader: true });
await mongoose.disconnect();
