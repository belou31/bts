
import express from 'express';

import { Campaign } from '../models/Campaign.js';
import { Zone } from '../models/Zone.js';
import { Order } from '../models/Order.js';
import { splitInstallments } from '../utils/money.js';
import { orderNo } from '../utils/ids.js';
import { getPriceFor } from '../services/pricing.js';
import { checkPhase } from '../middlewares/phase.js';

const router = express.Router();

router.get('/', checkPhase('tbh7'), async (req,res,next)=>{ /* ... */ });

router.post('/', checkPhase('tbh7'), async (req,res,next)=>{
  try{
    const { id } = req.query;
    const { zoneKey, persons = [], installmentsCount = 1, buyer } = req.body;
    const camp = await Campaign.findOne({ code: id, phase:'tbh7' });
    if (!camp) return res.status(404).json({ error: 'campaign not found' });
    const zone = await Zone.findOne({ key: zoneKey, seasonCode: camp.seasonCode });
    if (!zone) return res.status(404).json({ error: 'zone not found' });

    const items = [];
    for (const p of persons) {
      const pr = await getPriceFor({ seasonCode: camp.seasonCode, zoneKey, tariffCode: p.tariffCode || 'ADULT', context: 'tbh7' });
      items.push({ kind:'SEAT', zoneKey, quantity:1, tariffCode: p.tariffCode || 'ADULT', unitPriceCents: pr.unitPriceCents });
    }

    const total = items.reduce((a,i)=>a+i.unitPriceCents,0);

    const order = await Order.create({
      orderNo: orderNo(),
      seasonCode: camp.seasonCode,
      phase: 'tbh7',
      buyer, items,
      totals: { subtotalCents: total, discountCents:0, totalCents: total },
      installments: { count: installmentsCount, schedule: splitInstallments(total, installmentsCount) },
      status: 'pendingPayment'
    });

	const payRes = await fetch(`${process.env.APP_URL}/api/payments/helloasso/checkout`, {
	  method: 'POST',
	  headers: { 'Content-Type': 'application/json' },
	  body: JSON.stringify({
		orderNo: order.orderNo,
		subscriberId: null,
		seasonCode: order.seasonCode,
		totalCents: order.totals.totalCents,
		itemName: 'Abonnement TBH7',
		installments: installmentsCount,
		payer: {
		  email: buyer?.email,
		  firstName: buyer?.firstName,
		  lastName:  buyer?.lastName
		}
	  })
	});
	if (!payRes.ok) {
	  const err = await payRes.text();
	  throw new Error(`checkout failed: ${err}`);
	}
	const { redirectUrl, checkoutIntentId } = await payRes.json();

	order.helloAsso = { checkoutIntentId };
	await order.save();

	return res.json({ checkoutUrl: redirectUrl });

  }catch(e){ next(e); }
});

export default router;
