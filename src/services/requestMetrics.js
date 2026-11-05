// src/services/requestMetrics.js
// In-process (since last server start) HTTP activity counters, surfaced on
// the admin Monitoring > Système tab. Not persisted — resets on restart,
// same as the PM2/disk stats already shown there.

const routeCounts = new Map(); // "METHOD path" -> count
let concurrentRequests = 0;
let peakConcurrentRequests = 0;
let totalRequests = 0;
const startedAt = new Date();

export function requestMetricsMiddleware(req, res, next) {
  concurrentRequests += 1;
  if (concurrentRequests > peakConcurrentRequests) peakConcurrentRequests = concurrentRequests;

  res.on('finish', () => {
    concurrentRequests -= 1;
    totalRequests += 1;
    const routePath = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : req.path;
    const key = `${req.method} ${routePath}`;
    routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
  });

  next();
}

export function getRequestMetrics() {
  const topRoutes = Array.from(routeCounts.entries())
    .map(([key, count]) => {
      const spaceIdx = key.indexOf(' ');
      return { method: key.slice(0, spaceIdx), path: key.slice(spaceIdx + 1), count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    startedAt,
    totalRequests,
    concurrentRequests,
    peakConcurrentRequests,
    topRoutes
  };
}
