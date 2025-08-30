// src/middlewares/authz.js

// très simple pour l’instant : header X-Admin: 1 (à remplacer par JWT si besoin)
export function requireAdmin(req, res, next) {
  const isAdmin = req.headers['x-admin'] === '1';
  if (!isAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

export default { requireAdmin };
