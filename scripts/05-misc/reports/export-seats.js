/**
 * Export seats with provisioning/booked metadata.
 *
 * Usage:
 *   node scripts/04-admin-monitoring/reports/export-seats.js [--season=2025-2026] [--venue=patinoire-blagnac] [--zone=S1]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Template:
 *   - data/templates/csv/seats-export.template.csv
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { exportSeatsCsv } from '../../../src/services/exports.js';

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('MONGO_URI/MONGODB_URI manquant'); process.exit(1); }

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
