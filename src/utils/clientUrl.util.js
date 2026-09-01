const env = require('../config/env');

const LOCALHOST_RE = /localhost|127\.0\.0\.1|^https?:\/\/loc(:|\/|$)/i;

/** Live frontend — always used for email buttons on production / Resend */
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
 * Base URL for the app (OAuth redirects, health, etc.).
 * Production never returns localhost.
 */
function getClientBaseUrl() {
  const clientUrl = normalizeUrl(env.CLIENT_URL);
  const publicUrl = normalizeUrl(env.PUBLIC_APP_URL);
  const isProd = isProductionDeploy();

  if (isProd) {
    if (clientUrl && !isLocalhostUrl(clientUrl) && clientUrl.startsWith('https://')) {
      return clientUrl;
    }
    if (publicUrl && !isLocalhostUrl(publicUrl) && publicUrl.startsWith('https://')) {
      return publicUrl;
    }
    return PRODUCTION_APP_FALLBACK;
  }

  return clientUrl || 'http://localhost:5173';
}

/**
 * URL used inside emails (invite, task assign, project created, etc.).
 * NEVER localhost — real inboxes must open the live site.
 */
function getEmailAppUrl() {
  const candidates = [
    normalizeUrl(env.PUBLIC_APP_URL),
    normalizeUrl(env.CLIENT_URL),
    getClientBaseUrl(),
    PRODUCTION_APP_FALLBACK,
  ];

  for (const url of candidates) {
    if (url && !isLocalhostUrl(url) && /^https:\/\//i.test(url)) {
      return url;
    }
  }

  return PRODUCTION_APP_FALLBACK;
}

/**
 * Rewrite any localhost / broken link to the live app before putting it in email HTML.
 */
function ensureLiveEmailUrl(url, pathFallback = '') {
  const base = getEmailAppUrl();
  const raw = String(url || '').trim();

  if (!raw) {
    if (!pathFallback) return base;
    return `${base}${pathFallback.startsWith('/') ? pathFallback : `/${pathFallback}`}`;
  }

  try {
    const parsed = new URL(raw);
    const suffix = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`;
    if (isLocalhostUrl(parsed.origin) || !/^https:$/i.test(parsed.protocol)) {
      return `${base}${suffix === '/' ? '' : suffix}` || base;
    }
    return `${parsed.origin}${suffix === '/' ? '' : suffix}`;
  } catch {
    if (pathFallback) {
      return `${base}${pathFallback.startsWith('/') ? pathFallback : `/${pathFallback}`}`;
    }
    return base;
  }
}

/**
 * Resolve frontend URL from the incoming request (OAuth start, invite preview, etc.).
 */
function resolveClientUrlFromRequest(req) {
  if (!req) return getClientBaseUrl();

  const queryUrl = req.query?.clientUrl || req.query?.returnTo;
  if (queryUrl && isAllowedClientOrigin(queryUrl)) {
    const normalized = normalizeUrl(queryUrl);
    if (isProductionDeploy() && isLocalhostUrl(normalized)) {
      return getClientBaseUrl();
    }
    return normalized;
  }

  const origin = req.get?.('origin');
  if (origin && isAllowedClientOrigin(origin)) {
    const normalized = normalizeUrl(origin);
    if (isProductionDeploy() && isLocalhostUrl(normalized)) {
      return getClientBaseUrl();
    }
    return normalized;
  }

  const referer = req.get?.('referer');
  if (referer) {
    try {
      const parsed = new URL(referer);
      const base = normalizeUrl(`${parsed.protocol}//${parsed.host}`);
      if (isAllowedClientOrigin(base)) {
        if (isProductionDeploy() && isLocalhostUrl(base)) {
          return getClientBaseUrl();
        }
        return base;
      }
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

/** Paths for emails — always live HTTPS app */
function emailPath(path = '') {
  const base = getEmailAppUrl();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = {
  getClientBaseUrl,
  getEmailAppUrl,
  ensureLiveEmailUrl,
  resolveClientUrlFromRequest,
  isAllowedClientOrigin,
  isProductionDeploy,
  clientPath,
  emailPath,
  isLocalhostUrl,
  normalizeUrl,
  PRODUCTION_APP_FALLBACK,
};
