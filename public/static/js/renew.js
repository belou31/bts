// static/js/renew.js
//
// Standing/zone renewal support for /renew.
//
// A renewal JWT's `seatIds` can include virtual zone seat ids (e.g.
// "FAN_ZONE-Z001", built by import-subscription-orders.js's
// buildVirtualSeatId for standing-zone lines) — but the venue SVG only has
// one hotspot for the whole standing zone, not one per slot, so
// generic-view.js's click-the-SVG-seat model (findSeatElement) never finds
// an element to wire up and the row can never be added to the cart.
//
// Unlike a real seat — where clicking your labeled spot on the venue plan is
// itself a meaningful "yes, this one" confirmation among many seats — a
// standing-zone token entry is already fully determined: there is exactly
// one virtual seat id, nothing to pick out. So it's added to the cart
// automatically on load rather than requiring a click on a single button
// that can only ever mean "add the one thing already in my token." The
// subscriber can still remove it via the row's trash button, same as any
// other renewal line (e.g. to decline just one zone in a multi-line group).
(function () {
  const isVirtualZoneSeatId = (sid) => /^.+-Z\d{3,}$/i.test(String(sid || ''));
  const zoneKeyFromSeatId = (sid) => String(sid || '').split('-')[0] || '';

  function cartSeatIds() {
    return new Set(
      Array.from(document.querySelectorAll('#cartRows .cart-row')).map((row) => row.dataset.seatId)
    );
  }

  function addStandingTokenLines(ctx, data) {
    const api = window.BTS_VIEW.api;
    const inCart = cartSeatIds();
    const tokenSeats = Array.isArray(ctx?.tokenSeats) ? ctx.tokenSeats : [];
    // Real seats already get this via Seat.status/SVG coloring; virtual zone
    // seats have no Seat document, so /s/renew flags them in blockedSeats
    // when a paid/tobepaid order already covers them (already renewed).
    const blocked = new Set(Array.isArray(data?.blockedSeats) ? data.blockedSeats : []);

    for (const seatId of tokenSeats) {
      if (!isVirtualZoneSeatId(seatId) || inCart.has(seatId) || api.findSeatElement(seatId)) continue;
      if (blocked.has(seatId)) continue;
      const zoneKey = zoneKeyFromSeatId(seatId);
      api.addRowForSeat({ seatId, zoneKey, label: zoneKey.replace(/_/g, ' ') });
    }
  }

  window.BTS_VIEW.on('afterData', ({ ctx, data }) => addStandingTokenLines(ctx, data));
})();
