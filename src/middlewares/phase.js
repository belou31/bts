import { Season } from '../models/Season.js';

function checkPhase(phaseName) {
  return async function (req, res, next) {
    try {
      const season = await Season.findOne({ active: true });
      if (!season) return res.status(503).json({ error: 'no active season' });
      const ph = season.phases.find(p => p.name === phaseName);
      const now = new Date();
      const open = ph?.enabled && (!ph.openAt || ph.openAt <= now) && (!ph.closeAt || ph.closeAt >= now);
      if (!open) return res.status(403).json({ error: `phase ${phaseName} is closed` });
      // expose seasonCode for convenience
      req.seasonCode = season.code;
      next();
    } catch (e) { next(e); }
  };
}

export { checkPhase };
