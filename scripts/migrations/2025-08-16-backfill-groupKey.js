require('dotenv').config();

const mongoose = require('mongoose');
const Subscriber = require('../../src/models/Subscriber');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const r = await Subscriber.updateMany(
    { $or: [ { groupKey: { $exists: false } }, { groupKey: null }, { groupKey: '' } ] },
    [{ $set: { groupKey: { $ifNull: ['$email', ''] } } }]
  );
  console.log(`Backfilled groupKey on ${r.modifiedCount} subscribers`);
  await mongoose.disconnect();
})();
