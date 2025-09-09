// scripts/reports/export-orders.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { exportOrdersCsv } from '../../src/services/exports.js';

dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI manquant'); process.exit(1); }

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
