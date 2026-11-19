// src/models/AdClick.js
// Click log for personalized/trackable promo QR codes printed on tickets —
// written by the GET /promo/:token redirect route (see src/routes/promo.js).
// Purely an analytics trail; never read at render time. orderId/ticketId are
// enough to trace back to the event — targetUrl lives on the global
// AdCampaign master, not scoped per event, so no priceTableKey is needed here.
import mongoose from 'mongoose';

const AdClickSchema = new mongoose.Schema({
  campaignSlug: { type: String, required: true, index: true },
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null, index: true },
  orderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  token: { type: String, required: true },
  targetUrl: { type: String, default: null },
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  clickedAt: { type: Date, default: Date.now }
});

export const AdClick = mongoose.models.AdClick || mongoose.model('AdClick', AdClickSchema);
