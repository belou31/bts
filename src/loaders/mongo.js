// src/loaders/mongoose.js
import mongoose from 'mongoose';

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bts';
const IS_PROD = (process.env.APP_ENV || '').toLowerCase() === 'production';

mongoose.set('strictQuery', true);

(async () => {
  try {
    await mongoose.connect(URI, { autoIndex: !IS_PROD });
    const db = mongoose.connection;
    console.log(`[mongo] connected to ${db.host}:${db.port}/${db.name}`);
  } catch (err) {
    console.error('[mongo] connection error:', err.message);
    process.exit(1);
  }
})();

export default mongoose;
