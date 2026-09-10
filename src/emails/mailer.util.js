const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../config/logger');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const emailLogPath = path.join(logsDir, 'emails.log');

let transporter = null;
let smtpConfigured = false;
let lastSmtpError = null;
let activeProvider = null;
/** @type {{ at: number, verified: Set<string> } | null} */
let resendDomainCache = null;
const RESEND_DOMAIN_CACHE_MS = 5 * 60 * 1000;
const RESEND_TEST_FROM = 'BIWORKSPACE <onboarding@resend.dev>';
/** Only official BIWORKSPACE sender — never houseofchilli.pk or other domains */
const PRIMARY_SEND_DOMAIN = 'bicomworkspace.com';
const PRIMARY_FROM_EMAIL = `noreply@${PRIMARY_SEND_DOMAIN}`;

/**
 * Only allow Reply-To on official BIWORKSPACE domains.
 * Never surface a Super Admin personal mailbox (Gmail, etc.) to recipients.
 */
function sanitizeReplyTo(replyTo) {
  const raw = cleanSecret(replyTo);
  if (!raw) return null;
  const match = String(raw).match(/<([^>]+)>/);
  const email = String(match ? match[1] : raw)
    .trim()
    .toLowerCase();
  if (!email.includes('@')) return null;
  const domain = email.split('@')[1] || '';
  if (domain === PRIMARY_SEND_DOMAIN || domain === 'resend.dev') {
    return email;
  }
  return null;
}

function cleanSecret(value) {
  if (value == null) return value;
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  if (/^[a-zA-Z0-9 ]{16,20}$/.test(s) && s.includes(' ')) {
    return s.replace(/\s+/g, '');
  }
  return s;
}

function resolveSmtpPass() {
  const b64 = cleanSecret(env.SMTP_PASS_B64);
  if (b64) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      logger.warn('SMTP_PASS_B64 is not valid base64');
    }
  }
  return cleanSecret(env.SMTP_PASS);
}

function resetTransporter() {
  transporter = null;
  smtpConfigured = false;
  activeProvider = null;
  resendDomainCache = null;
}

const LEGACY_FROM_RE = /houseofchilli\.pk|tasksmtp@bicommunications\.ae/i;

function preferredFromAddress() {
  return `BIWORKSPACE <${PRIMARY_FROM_EMAIL}>`;
}

function parseFromAddress(fromValue) {
  let raw = cleanSecret(fromValue) || cleanSecret(env.EMAIL_FROM) || preferredFromAddress();

  if (LEGACY_FROM_RE.test(String(raw)) || !String(raw).includes('@')) {
    const preferred = preferredFromAddress();
    if (LEGACY_FROM_RE.test(String(raw))) {
      logger.warn(`Ignoring legacy EMAIL_FROM (${raw}) — using ${preferred}`);
    }
    raw = preferred;
  }

  const match = String(raw).match(/^(.*)<([^>]+)>$/);
  if (match) {
    const email = match[2].trim();
    const name = match[1].trim().replace(/^["']|["']$/g, '') || 'BIWORKSPACE';
    if (LEGACY_FROM_RE.test(email)) {
      return parseFromAddress(preferredFromAddress());
    }
    return {
      name,
      email,
      formatted: `${name} <${email}>`,
    };
  }

  const email = String(raw).trim();
  if (LEGACY_FROM_RE.test(email) || !email.includes('@')) {
    return parseFromAddress(preferredFromAddress());
  }
  return { name: 'BIWORKSPACE', email, formatted: `BIWORKSPACE <${email}>` };
}

function plainTextFromHtml(html, fallbackText) {
  if (fallbackText) return fallbackText;
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function isSmtpReady() {
  return Boolean(env.SMTP_HOST && cleanSecret(env.SMTP_USER) && resolveSmtpPass());
}

/** Render blocks/unreliably resolves custom SMTP hosts (EAI_AGAIN mail.*). Use API mail there. */
function isRenderHost() {
  return (
    process.env.RENDER === 'true' ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function smtpAllowed() {
  // Explicit opt-in only on Render — DNS to mail.bicomworkspace.com fails there
  if (isRenderHost()) {
    return String(env.EMAIL_PROVIDER || '').trim().toLowerCase() === 'smtp';
  }
  return true;
}

function resolveEmailProvider() {
  const forced = String(env.EMAIL_PROVIDER || 'auto').trim().toLowerCase();
  const resendKey = cleanSecret(env.RESEND_API_KEY);
  const brevoKey = cleanSecret(env.BREVO_API_KEY);
  const smtpReady = isSmtpReady() && smtpAllowed();

  if (forced === 'resend') {
    if (resendKey) return 'resend';
    // On Render never silently fall back to SMTP (causes getaddrinfo EAI_AGAIN)
    if (smtpReady && !isRenderHost()) {
      logger.warn('EMAIL_PROVIDER=resend but RESEND_API_KEY missing — using SMTP');
      return 'smtp';
    }
    return 'none';
  }
  if (forced === 'brevo') {
    if (brevoKey) return 'brevo';
    if (smtpReady && !isRenderHost()) {
      logger.warn('EMAIL_PROVIDER=brevo but BREVO_API_KEY missing — using SMTP');
      return 'smtp';
    }
    return 'none';
  }
  if (forced === 'smtp') {
    if (isSmtpReady()) return 'smtp';
    if (resendKey) return 'resend';
    if (brevoKey) return 'brevo';
    return 'none';
  }

  // auto / missing: prefer Resend everywhere when key is set (works on Render + local)
  if (resendKey) return 'resend';
  if (brevoKey) return 'brevo';
  if (smtpReady) return 'smtp';
  return 'none';
}

function getTransporter() {
  if (transporter) return transporter;

  const host = env.SMTP_HOST;
  const user = cleanSecret(env.SMTP_USER);
  const pass = resolveSmtpPass();
  const port = Number(env.SMTP_PORT) || 465;

  if (host && user && pass) {
    smtpConfigured = true;
    const isGmail = /gmail\.com$/i.test(host);
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user, pass },
      authMethod: 'LOGIN',
      tls: {
        minVersion: 'TLSv1.2',
        // cPanel / shared hosting often uses a name mismatch on the cert
        rejectUnauthorized: isGmail,
      },
    });
    logger.info(
      `SMTP transporter configured (${host}:${port}) user=${user} passLen=${pass.length}`
    );
  } else {
    smtpConfigured = false;
    transporter = {
      sendMail: async (opts) => {
        const entry = {
          at: new Date().toISOString(),
          to: opts.to,
          subject: opts.subject,
          from: opts.from,
          preview: String(opts.html || '').slice(0, 500),
        };
        fs.appendFileSync(emailLogPath, `${JSON.stringify(entry)}\n`);
        logger.info(`Email logged (no SMTP): to=${opts.to} subject="${opts.subject}"`);
        return { messageId: `dev-${Date.now()}`, accepted: [opts.to], logged: true };
      },
    };
    if (!pass && (env.SMTP_HOST || env.SMTP_USER)) {
      logger.warn(
        'SMTP host/user set but password is empty — if the password starts with #, use SMTP_PASS_B64 instead'
      );
    }
  }

  return transporter;
}

async function listVerifiedResendDomains(apiKey) {
  if (resendDomainCache && Date.now() - resendDomainCache.at < RESEND_DOMAIN_CACHE_MS) {
    return resendDomainCache.verified;
  }
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json().catch(() => ({}));
    const verified = new Set(
      (body?.data || [])
        .filter((d) => String(d.status).toLowerCase() === 'verified')
        .map((d) => String(d.name).toLowerCase())
    );
    resendDomainCache = { at: Date.now(), verified };
    return verified;
  } catch (err) {
    logger.warn(`Could not list Resend domains: ${err.message}`);
    return resendDomainCache?.verified || new Set();
  }
}

/**
 * Resend: only noreply@bicomworkspace.com when verified.
 * Never houseofchilli.pk or any other domain — matches local BIWORKSPACE setup.
 */
async function resolveResendFrom(apiKey) {
  const verified = await listVerifiedResendDomains(apiKey);

  if (verified.has(PRIMARY_SEND_DOMAIN)) {
    logger.info(`Resend From locked to BIWORKSPACE <${PRIMARY_FROM_EMAIL}> (verified)`);
    return {
      name: 'BIWORKSPACE',
      email: PRIMARY_FROM_EMAIL,
      formatted: `BIWORKSPACE <${PRIMARY_FROM_EMAIL}>`,
      verifiedDomain: true,
    };
  }

  logger.warn(
    `Resend: ${PRIMARY_SEND_DOMAIN} not verified — using onboarding@resend.dev until DNS is verified at resend.com/domains`
  );
  return {
    name: 'BIWORKSPACE',
    email: 'onboarding@resend.dev',
    formatted: RESEND_TEST_FROM,
    verifiedDomain: false,
  };
}

async function sendViaResend({ to, subject, html, text, replyTo }, { allowRetryWithTestFrom = true } = {}) {
  const apiKey = cleanSecret(env.RESEND_API_KEY);
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const fromInfo = await resolveResendFrom(apiKey);
  const usingVerifiedDomain = Boolean(fromInfo.verifiedDomain);

  const payload = {
    from: fromInfo.formatted,
    to: [to],
    subject,
    html,
    text: plainTextFromHtml(html, text),
  };
  // Only allow official-domain Reply-To — never a personal Super Admin mailbox
  const safeReply = sanitizeReplyTo(replyTo);
  if (safeReply) payload.reply_to = safeReply;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.message || body?.error || `Resend HTTP ${res.status}`;
    const isTestRecipientOnly = /only send testing emails to your own email address/i.test(
      String(message)
    );

    // Custom From rejected → retry once with Resend's test sender (still to the SAME recipient).
    if (
      allowRetryWithTestFrom &&
      /domain is not verified|invalid.*from|not verified/i.test(message) &&
      !/onboarding@resend\.dev/i.test(String(payload.from))
    ) {
      logger.warn(`Resend from rejected (${message}) — forcing onboarding@resend.dev`);
      resendDomainCache = { at: Date.now(), verified: new Set() };
      return sendViaResend(
        { to, subject, html, text, replyTo },
        { allowRetryWithTestFrom: false }
      );
    }

    // Never redirect invites to the Resend account owner. Invites must reach `to`.
    if (isTestRecipientOnly) {
      throw new Error(
        `Resend cannot deliver to ${to} until ${PRIMARY_SEND_DOMAIN} is verified. ` +
          `Verify the domain at https://resend.com/domains (or set BREVO_API_KEY as fallback).`
      );
    }

    throw new Error(message);
  }

  return {
    messageId: body.id || `resend-${Date.now()}`,
    accepted: [to],
    rejected: [],
    response: 'Resend accepted',
    from: payload.from,
    provider: 'resend',
    intendedTo: to,
    redirected: false,
    emailRedirectedTo: null,
    deliveryTo: to,
    deliveryStatus: usingVerifiedDomain ? 'sent' : 'sent_via_resend_test_from',
  };
}

async function getResendEmailStatus(emailId) {
  const apiKey = cleanSecret(env.RESEND_API_KEY);
  if (!apiKey || !emailId) return null;
  try {
    const res = await fetch(`https://api.resend.com/emails/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      id: body.id,
      to: body.to,
      from: body.from,
      subject: body.subject,
      lastEvent: body.last_event,
    };
  } catch {
    return null;
  }
}

async function sendViaBrevo({ to, subject, html, text, replyTo }) {
  const apiKey = cleanSecret(env.BREVO_API_KEY);
  if (!apiKey) throw new Error('BREVO_API_KEY is not set');

  const fromInfo = parseFromAddress(preferredFromAddress());

  const payload = {
    sender: { name: fromInfo.name, email: fromInfo.email },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: plainTextFromHtml(html, text),
  };
  if (replyTo) {
    const safeReply = sanitizeReplyTo(replyTo);
    if (safeReply) payload.replyTo = { email: safeReply };
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || JSON.stringify(body) || `Brevo HTTP ${res.status}`);
  }

  return {
    messageId: body.messageId || `brevo-${Date.now()}`,
    accepted: [to],
    rejected: [],
    response: 'Brevo accepted',
    from: `${fromInfo.name} <${fromInfo.email}>`,
    provider: 'brevo',
  };
}

async function sendViaSmtp({ to, subject, html, text, replyTo }) {
  const tx = getTransporter();
  const fromInfo = parseFromAddress();
  const from = fromInfo.formatted;
  const smtpUser = cleanSecret(env.SMTP_USER);

  const result = await tx.sendMail({
    from,
    to,
    subject,
    html,
    text: plainTextFromHtml(html, text),
    replyTo: sanitizeReplyTo(replyTo) || undefined,
    envelope: {
      from: smtpUser || fromInfo.email,
      to: [to],
    },
    headers: {
      'X-Mailer': 'BIWORKSPACE',
      'X-Entity-Ref-ID': `biworkspace-${Date.now()}`,
    },
  });

  if (Array.isArray(result?.rejected) && result.rejected.length > 0) {
    throw new Error(`Mail server rejected recipient: ${result.rejected.join(', ')}`);
  }

  logger.info(
    `SMTP accepted mail from=${from} to=${to} id=${result.messageId || 'n/a'} response=${result.response || 'ok'}`
  );
  if (/@(gmail|googlemail)\.com$/i.test(to)) {
    logger.warn(
      'Gmail often drops cPanel SMTP without SPF/DKIM on bicomworkspace.com. Prefer EMAIL_PROVIDER=resend until DNS is verified.'
    );
  }

  return {
    ...result,
    from,
    provider: result?.logged ? 'log' : 'smtp',
  };
}

async function sendMail({ to, subject, html, text, replyTo }) {
  if (!to) throw new Error('Missing email recipient');

  const recipient = String(to).trim().toLowerCase();
  let provider = resolveEmailProvider();
  activeProvider = provider;

  if (provider === 'none') {
    const onRender = isRenderHost();
    throw new Error(
      onRender
        ? 'Email not configured on Render. Set RESEND_API_KEY and EMAIL_PROVIDER=resend (SMTP to mail.bicomworkspace.com does not work on Render).'
        : 'No email provider configured. Set RESEND_API_KEY (recommended), BREVO_API_KEY, or SMTP_* in backend/.env'
    );
  }

  // Prefer Brevo/SMTP when Resend domain is unverified — test From can only
  // reach the Resend account owner, so assignees never get mail otherwise.
  if (provider === 'resend' && cleanSecret(env.RESEND_API_KEY)) {
    try {
      const verified = await listVerifiedResendDomains(cleanSecret(env.RESEND_API_KEY));
      if (!verified.has(PRIMARY_SEND_DOMAIN)) {
        if (cleanSecret(env.BREVO_API_KEY)) {
          logger.warn(
            `Resend ${PRIMARY_SEND_DOMAIN} not verified — using Brevo so mail reaches ${recipient}`
          );
          provider = 'brevo';
          activeProvider = 'brevo';
        } else if (isSmtpReady() && smtpAllowed()) {
          logger.warn(
            `Resend ${PRIMARY_SEND_DOMAIN} not verified — using SMTP so mail reaches ${recipient}`
          );
          provider = 'smtp';
          activeProvider = 'smtp';
        } else {
          logger.warn(
            `Resend ${PRIMARY_SEND_DOMAIN} not verified and no Brevo/SMTP fallback — ` +
              `assignment emails may only reach the Resend account owner`
          );
        }
      }
    } catch {
      /* keep Resend */
    }
  }

  try {
    let result;
    if (provider === 'resend') {
      result = await sendViaResend({ to: recipient, subject, html, text, replyTo });
    } else if (provider === 'brevo') {
      result = await sendViaBrevo({ to: recipient, subject, html, text, replyTo });
    } else {
      result = await sendViaSmtp({ to: recipient, subject, html, text, replyTo });
    }

    if (result?.logged) {
      throw new Error('Email provider only logged locally — configure RESEND_API_KEY or SMTP');
    }

    if (result?.redirected || result?.emailRedirectedTo) {
      throw new Error(
        `Invite must go to ${recipient}, but the provider redirected delivery. ` +
          `Verify ${PRIMARY_SEND_DOMAIN} at https://resend.com/domains`
      );
    }

    lastSmtpError = null;
    logger.info(
      `Email sent via ${result.provider} to ${recipient}: "${subject}" id=${result.messageId}`
    );
    return {
      ...result,
      intendedTo: recipient,
      deliveryTo: recipient,
      emailRedirectedTo: null,
      redirected: false,
    };
  } catch (err) {
    lastSmtpError = err.message;

    const isResendRecipientLimit =
      /only send testing emails to your own email|cannot deliver to .+ until .+ is verified/i.test(
        err.message || ''
      );
    const forcedResend = String(env.EMAIL_PROVIDER || '').toLowerCase() === 'resend';
    const dnsFail = /EAI_AGAIN|ENOTFOUND|getaddrinfo/i.test(err.message || '');

    if (isResendRecipientLimit && cleanSecret(env.BREVO_API_KEY) && provider !== 'brevo') {
      try {
        logger.warn(`Falling back to Brevo for ${recipient}`);
        activeProvider = 'brevo';
        const brevoResult = await sendViaBrevo({
          to: recipient,
          subject,
          html,
          text,
          replyTo,
        });
        lastSmtpError = null;
        return {
          ...brevoResult,
          intendedTo: recipient,
          deliveryTo: recipient,
          emailRedirectedTo: null,
          redirected: false,
        };
      } catch (brevoErr) {
        lastSmtpError = brevoErr.message;
        logger.error(`Brevo fallback failed for ${recipient}: ${brevoErr.message}`);
      }
    }

    // Always try SMTP when Resend cannot deliver to arbitrary recipients
    if (
      (isResendRecipientLimit || provider === 'resend') &&
      isSmtpReady() &&
      smtpAllowed() &&
      provider !== 'smtp'
    ) {
      try {
        logger.warn(`Falling back to SMTP for ${recipient}`);
        activeProvider = 'smtp';
        const smtpResult = await sendViaSmtp({
          to: recipient,
          subject,
          html,
          text,
          replyTo,
        });
        lastSmtpError = null;
        logger.info(
          `Email sent via smtp fallback to ${recipient}: "${subject}" id=${smtpResult.messageId}`
        );
        return {
          ...smtpResult,
          intendedTo: recipient,
          deliveryTo: recipient,
          emailRedirectedTo: null,
          redirected: false,
        };
      } catch (smtpErr) {
        lastSmtpError = smtpErr.message;
        logger.error(`SMTP fallback failed for ${recipient}: ${smtpErr.message}`);
      }
    }

    if (forcedResend || isResendRecipientLimit || isRenderHost()) {
      resetTransporter();
      if (isResendRecipientLimit) {
        throw new Error(
          `Email could not be delivered to ${recipient}. ` +
            `Verify ${PRIMARY_SEND_DOMAIN} at https://resend.com/domains ` +
            `(or set BREVO_API_KEY / configure SMTP).`
        );
      }
      if (dnsFail && /mail\.|smtp/i.test(err.message || '')) {
        throw new Error(
          `SMTP host DNS failed (${err.message}). ` +
            (isRenderHost()
              ? 'On Render use a verified Resend domain or BREVO_API_KEY (cPanel SMTP usually does not resolve).'
              : `Fix SMTP_HOST DNS, or verify ${PRIMARY_SEND_DOMAIN} at https://resend.com/domains, or set BREVO_API_KEY.`)
        );
      }
      throw err;
    }

    if ((provider === 'resend' || provider === 'brevo') && isSmtpReady() && smtpAllowed()) {
      logger.warn(`${provider} failed (${err.message}) — falling back to SMTP`);
      try {
        const fallback = await sendViaSmtp({ to: recipient, subject, html, text, replyTo });
        if (fallback?.logged) throw new Error(err.message);
        logger.info(
          `Email sent via smtp fallback to ${recipient}: "${subject}" id=${fallback.messageId}`
        );
        return {
          ...fallback,
          intendedTo: recipient,
          deliveryTo: recipient,
          emailRedirectedTo: null,
          redirected: false,
        };
      } catch (smtpErr) {
        lastSmtpError = smtpErr.message;
        resetTransporter();
        throw new Error(
          `${provider} failed: ${err.message}; SMTP fallback failed: ${smtpErr.message}`
        );
      }
    }
    resetTransporter();
    if (dnsFail) {
      throw new Error(
        `Email DNS failed (${err.message}). On live/Render use RESEND_API_KEY instead of SMTP.`
      );
    }
    throw err;
  }
}

async function verifySmtpConnection() {
  const provider = resolveEmailProvider();
  activeProvider = provider;

  if (provider === 'none') {
    lastSmtpError = 'No email provider configured (RESEND_API_KEY / BREVO_API_KEY / SMTP_*)';
    return { ok: false, reason: lastSmtpError, provider };
  }

  if (provider === 'resend') {
    const apiKey = cleanSecret(env.RESEND_API_KEY);
    let domainVerified = false;
    let fromEmail = PRIMARY_FROM_EMAIL;
    if (apiKey) {
      try {
        const verified = await listVerifiedResendDomains(apiKey);
        domainVerified = verified.has(PRIMARY_SEND_DOMAIN);
        fromEmail = domainVerified ? PRIMARY_FROM_EMAIL : 'onboarding@resend.dev';
      } catch {
        /* keep defaults */
      }
    }
    lastSmtpError = null;
    const canDeliverToAnyRecipient = Boolean(apiKey) && domainVerified;
    if (apiKey && !domainVerified) {
      logger.warn(
        `Resend is in test mode (${PRIMARY_SEND_DOMAIN} not verified). ` +
          `Task/project assignment emails to other inboxes (not the Resend account owner) will fail. ` +
          `Verify the domain at https://resend.com/domains or set BREVO_API_KEY.`
      );
    }
    return {
      ok: Boolean(apiKey),
      reason: apiKey
        ? domainVerified
          ? `${PRIMARY_SEND_DOMAIN} verified — sends as ${fromEmail}`
          : `${PRIMARY_SEND_DOMAIN} not verified on Resend — verify at resend.com/domains`
        : 'RESEND_API_KEY missing',
      provider: 'resend',
      user: fromEmail,
      domainVerified,
      canDeliverToAnyRecipient,
      sendDomain: PRIMARY_SEND_DOMAIN,
    };
  }

  if (provider === 'brevo') {
    lastSmtpError = null;
    return {
      ok: true,
      reason: 'Brevo API key configured',
      provider: 'brevo',
      user: parseFromAddress().email,
    };
  }

  try {
    resetTransporter();
    const tx = getTransporter();
    if (typeof tx.verify === 'function') {
      await tx.verify();
    }
    lastSmtpError = null;
    return { ok: true, reason: 'connected', provider: 'smtp', user: cleanSecret(env.SMTP_USER) };
  } catch (err) {
    lastSmtpError = err.message;
    const hint = /BadCredentials|Invalid login|535/i.test(err.message)
      ? ` Check SMTP credentials, or switch to RESEND_API_KEY / BREVO_API_KEY for reliable delivery.`
      : '';
    return { ok: false, reason: `${err.message}${hint}`, provider: 'smtp' };
  }
}

function getLastSmtpError() {
  return lastSmtpError;
}

function getActiveEmailProvider() {
  return activeProvider || resolveEmailProvider();
}

module.exports = {
  sendMail,
  verifySmtpConnection,
  verifyEmailConnection: verifySmtpConnection,
  getResendEmailStatus,
  smtpConfigured: () => smtpConfigured || ['resend', 'brevo'].includes(resolveEmailProvider()),
  getLastSmtpError,
  getActiveEmailProvider,
  resolveEmailProvider,
  resetTransporter,
};
