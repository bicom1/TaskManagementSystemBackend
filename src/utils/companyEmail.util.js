/**
 * Company cPanel/webmail domain — invitees register with email + password.
 * All other domains keep the existing Google invite flow.
 */
const COMPANY_WEBMAIL_DOMAIN = 'bicommunications.net';

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function isCompanyWebmailEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith(`@${COMPANY_WEBMAIL_DOMAIN}`);
}

module.exports = {
  COMPANY_WEBMAIL_DOMAIN,
  normalizeEmail,
  isCompanyWebmailEmail,
};
