const env = require('../config/env');

const LOCALHOST_RE = /localhost|127\.0\.0\.1/i;

/** Default live frontend when production env is misconfigured */
const PRODUCTION_APP_FALLBACK = 'https://task-management-system-frontend-z23.vercel.app';

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function isLocalhostUrl(url) {
  return LOCALHOST_RE.test(normalizeUrl(url));
}

function isProductionDeploy() {
  return (
    env.NODE_ENV === 'production' ||
    Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim()) ||
    Boolean(String(process.env.RAILWAY_ENVIRONMENT || '').trim())
  );
}

/**
 * Origins allowed for OAuth return URLs, email links, and CORS.
 */
function isAllowedClientOrigin(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;

  const allowed = new Set(
    [
      normalizeUrl(env.CLIENT_URL),
      normalizeUrl(env.PUBLIC_APP_URL),
      PRODUCTION_APP_FALLBACK,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ].filter(Boolean)
  );

  if (allowed.has(normalized)) return true;

  if (/^https:\/\/task-management-system-frontend[\w-]*\.vercel\.app$/i.test(normalized)) {
    return true;
  }

  if (!isProductionDeploy() && isLocalhostUrl(normalized)) {
    return true;
  }

  return false;
}

/**
 * Base URL for links in emails, invites, password reset, and OAuth redirects.
 * - Local dev → CLIENT_URL (http://localhost:5173)
 * - Production → never localhost; uses CLIENT_URL, PUBLIC_APP_URL, or live fallback
 */
function getClientBaseUrl() {
  const clientUrl = normalizeUrl(env.CLIENT_URL);
  const publicUrl = normalizeUrl(env.PUBLIC_APP_URL);
  const isProd = isProductionDeploy();

  if (isProd) {
    if (clientUrl && !isLocalhostUrl(clientUrl)) return clientUrl;
    if (publicUrl && !isLocalhostUrl(publicUrl)) return publicUrl;
    return PRODUCTION_APP_FALLBACK;
  }

  return clientUrl || 'http://localhost:5173';
}

/**
 * Resolve frontend URL from the incoming request (OAuth start, invite preview, etc.).
 * Priority: ?clientUrl / ?returnTo → Origin → Referer → getClientBaseUrl()
 */
function resolveClientUrlFromRequest(req) {
  if (!req) return getClientBaseUrl();

  const queryUrl = req.query?.clientUrl || req.query?.returnTo;
  if (queryUrl && isAllowedClientOrigin(queryUrl)) {
    return normalizeUrl(queryUrl);
  }

  const origin = req.get?.('origin');
  if (origin && isAllowedClientOrigin(origin)) {
    return normalizeUrl(origin);
  }

  const referer = req.get?.('referer');
  if (referer) {
    try {
      const parsed = new URL(referer);
      const base = normalizeUrl(`${parsed.protocol}//${parsed.host}`);
      if (isAllowedClientOrigin(base)) return base;
    } catch {
      // ignore invalid referer
    }
  }

  return getClientBaseUrl();
}

function clientPath(path = '') {
  const base = getClientBaseUrl();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = {
  getClientBaseUrl,
  resolveClientUrlFromRequest,
  isAllowedClientOrigin,
  isProductionDeploy,
  clientPath,
  isLocalhostUrl,
  normalizeUrl,
  PRODUCTION_APP_FALLBACK,
};
