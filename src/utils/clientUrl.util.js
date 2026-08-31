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

/**
 * Base URL for links in emails, invites, and password reset.
 * - Local dev → CLIENT_URL (http://localhost:5173)
 * - Production → never localhost; uses CLIENT_URL, PUBLIC_APP_URL, or live fallback
 */
function getClientBaseUrl() {
  const clientUrl = normalizeUrl(env.CLIENT_URL);
  const publicUrl = normalizeUrl(env.PUBLIC_APP_URL);
  const isProd = env.NODE_ENV === 'production';

  if (isProd) {
    if (clientUrl && !isLocalhostUrl(clientUrl)) return clientUrl;
    if (publicUrl && !isLocalhostUrl(publicUrl)) return publicUrl;
    return PRODUCTION_APP_FALLBACK;
  }

  return clientUrl || 'http://localhost:5173';
}

function clientPath(path = '') {
  const base = getClientBaseUrl();
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

module.exports = {
  getClientBaseUrl,
  clientPath,
  isLocalhostUrl,
  PRODUCTION_APP_FALLBACK,
};
