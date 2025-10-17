/**
 * Export orders as CSV via shared service.
 *
 * Usage:
 *   node scripts/04-admin-monitoring/reports/export-orders.js [--season=2025-2026] [--venue=patinoire-blagnac] [--status=paid]
 *
 * Environment:
 *   - MONGO_URI or MONGODB_URI (required)
 *   - MONGODB_DB (optional database name)
 *
 * Template:
 *   - data/templates/csv/orders-export.template.csv
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { exportOrdersCsv } from '../../../src/services/exports.js';

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) { console.error('MONGO_URI/MONGODB_URI manquant'); process.exit(1); }

const season = process.argv.find(a => a.startsWith('--season='))?.split('=')[1] || null;
const venue  = process.argv.find(a => a.startsWith('--venue=')) ?.split('=')[1] || null;
const status = process.argv.find(a => a.startsWith('--status='))?.split('=')[1] || null;

const filter = {};
if (season) filter.seasonCode = season;
if (venue)  filter.venueSlug  = venue;
if (status) filter.status     = status;

await mongoose.connect(uri, { dbName: process.env.MONGODB_DB });
await exportOrdersCsv({ out: process.stdout, filter, includeHeader: true });
await mongoose.disconnect();
