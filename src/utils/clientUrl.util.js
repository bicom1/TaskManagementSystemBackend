const env = require('../config/env');

const LOCALHOST_RE = /localhost|127\.0\.0\.1|^https?:\/\/loc(:|\/|$)/i;

/**
 * Canonical live frontend (cPanel). Invite emails + OAuth fallbacks must use this —
 * not the old Vercel preview URL.
 */
const PRODUCTION_APP_FALLBACK = 'https://bicomworkspace.com';

/**
 * Custom production domain on cPanel. Accepted regardless of CLIENT_URL so a
 * missing or mistyped env var on the API host cannot CORS-block the whole app.
 * The .htaccess redirects www to the apex, but both are allowed defensively.
 */
const CUSTOM_DOMAIN_ORIGINS = ['https://bicomworkspace.com', 'https://www.bicomworkspace.com'];

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
      ...CUSTOM_DOMAIN_ORIGINS,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      // Legacy Vercel preview (keep working during cutover)
      'https://task-management-system-frontend-z23.vercel.app',
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
 * Production never returns localhost — prefers bicomworkspace.com.
 */
function getClientBaseUrl() {
  const clientUrl = normalizeUrl(env.CLIENT_URL);
  const publicUrl = normalizeUrl(env.PUBLIC_APP_URL);
  const isProd = isProductionDeploy();

  if (isProd) {
    // Prefer the live custom domain when env still points at Vercel/localhost
    const preferCustom =
      CUSTOM_DOMAIN_ORIGINS.includes(clientUrl) ||
      CUSTOM_DOMAIN_ORIGINS.includes(publicUrl);
    if (preferCustom) {
      return CUSTOM_DOMAIN_ORIGINS.includes(clientUrl) ? clientUrl : publicUrl;
    }
    if (
      clientUrl &&
      !isLocalhostUrl(clientUrl) &&
      clientUrl.startsWith('https://') &&
      !/vercel\.app/i.test(clientUrl)
    ) {
      return clientUrl;
    }
    if (
      publicUrl &&
      !isLocalhostUrl(publicUrl) &&
      publicUrl.startsWith('https://') &&
      !/vercel\.app/i.test(publicUrl)
    ) {
      return publicUrl;
    }
    return PRODUCTION_APP_FALLBACK;
  }

  return clientUrl || 'http://localhost:5173';
}

/**
 * URL used inside emails (invite, task assign, project created, etc.).
 * Always https://bicomworkspace.com in production so cPanel webmail opens the live app.
 */
function getEmailAppUrl() {
  const candidates = [
    CUSTOM_DOMAIN_ORIGINS[0],
    ...CUSTOM_DOMAIN_ORIGINS,
    normalizeUrl(env.PUBLIC_APP_URL),
    normalizeUrl(env.CLIENT_URL),
    getClientBaseUrl(),
    PRODUCTION_APP_FALLBACK,
  ];

  for (const url of candidates) {
    if (
      url &&
      !isLocalhostUrl(url) &&
      /^https:\/\//i.test(url) &&
      !/vercel\.app/i.test(url)
    ) {
      return url;
    }
  }

  return CUSTOM_DOMAIN_ORIGINS[0];
}

/**
 * Rewrite any localhost / broken link to the live app before putting it in email HTML.
 * Always preserve ?token= / query string when present on the original URL.
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
    let pathname = parsed.pathname || '';
    // Canonical invite path for live + local email links
    if (/^\/accept-invite\/?$/i.test(pathname)) {
      pathname = '/register';
    }
    const suffix = `${pathname}${parsed.search || ''}${parsed.hash || ''}`;
    if (isLocalhostUrl(parsed.origin) || !/^https:$/i.test(parsed.protocol)) {
      return `${base}${suffix === '/' ? '' : suffix}` || base;
    }
    // Always normalize accept-invite → register on the live app host
    if (/bicomworkspace\.com$/i.test(parsed.hostname) && pathname === '/register') {
      return `${base}${suffix === '/' ? '' : suffix}`;
    }
    return `${parsed.origin}${suffix === '/' ? '' : suffix}`;
  } catch {
    // Keep query string if the raw value looks like a path + token
    const pathMatch = raw.match(/^(\/[^?\s]*)(\?.*)?$/);
    if (pathMatch) {
      return `${base}${pathMatch[1]}${pathMatch[2] || ''}`;
    }
    const tokenMatch = raw.match(/[?&](?:token|inviteToken)=([^&\s]+)/i);
    if (tokenMatch?.[1]) {
      const path = pathFallback || '/register';
      const cleanPath = path.startsWith('/') ? path.split('?')[0] : `/${path.split('?')[0]}`;
      return `${base}${cleanPath}?token=${encodeURIComponent(tokenMatch[1])}`;
    }
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
