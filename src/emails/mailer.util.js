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


function resolveEmailProvider() {
  const forced = String(env.EMAIL_PROVIDER || 'auto').trim().toLowerCase();
  const resendKey = cleanSecret(env.RESEND_API_KEY);
  const brevoKey = cleanSecret(env.BREVO_API_KEY);
  const smtpReady = isSmtpReady();

  if (forced === 'resend') {
    if (resendKey) return 'resend';
    if (smtpReady) {
      logger.warn('EMAIL_PROVIDER=resend but RESEND_API_KEY missing — using SMTP');
      return 'smtp';
    }
    return 'none';
  }
  if (forced === 'brevo') {
    if (brevoKey) return 'brevo';
    if (smtpReady) {
      logger.warn('EMAIL_PROVIDER=brevo but BREVO_API_KEY missing — using SMTP');
      return 'smtp';
    }
    return 'none';
  }
  if (forced === 'smtp') {
    if (smtpReady) return 'smtp';
    if (resendKey) return 'resend';
    if (brevoKey) return 'brevo';
    return 'none';
  }

  // auto: prefer Resend (reliable Gmail delivery), then Brevo, then SMTP
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

function wrapRedirectedInviteHtml(intendedTo, html) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:14px 16px;margin-bottom:16px;color:#9a3412;">
        <strong>Temporary Resend test mode</strong><br/>
        Domain not verified yet, so this invite was delivered to your Resend account inbox.<br/>
        <strong>Intended recipient:</strong> ${intendedTo}<br/>
        Forward this email to them, or share the accept link / password from the invite screen.<br/>
        Later: verify your domain at resend.com/domains to send directly to any user.
      </div>
      ${html}
    </div>
  `;
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

async function sendViaResend({ to, subject, html, text, replyTo }, { allowRedirect = true } = {}) {
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
  const smtpUser = cleanSecret(env.SMTP_USER);
  if (replyTo || smtpUser) payload.reply_to = replyTo || smtpUser;

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
    const match = String(message).match(
      /only send testing emails to your own email address \(([^)]+)\)/i
    );

    // Domain rejection while still using a custom From → should not happen often;
    // resolveResendFrom already switches to onboarding@resend.dev when unverified.
    if (
      allowRedirect &&
      /domain is not verified|invalid.*from|not verified/i.test(message) &&
      !/onboarding@resend\.dev/i.test(String(payload.from))
    ) {
      logger.warn(`Resend from rejected (${message}) — forcing onboarding@resend.dev`);
      resendDomainCache = { at: Date.now(), verified: new Set() };
      return sendViaResend({ to, subject, html, text, replyTo }, { allowRedirect: true });
    }

    // Test-mode recipient limit: deliver to the Resend account inbox instead
    if (!usingVerifiedDomain && allowRedirect && match?.[1]) {
      const allowedInbox = String(match[1]).trim().toLowerCase();
      const intended = String(to).trim().toLowerCase();
      if (allowedInbox && intended !== allowedInbox) {
        logger.warn(
          `Resend test mode: redirecting email for ${intended} → ${allowedInbox} (verify bicomworkspace.com for direct delivery)`
        );
        const redirected = await sendViaResend(
          {
            to: allowedInbox,
            subject: `[Invite for ${intended}] ${subject}`,
            html: wrapRedirectedInviteHtml(intended, html),
            text: [
              `TEMPORARY: intended recipient is ${intended}`,
              `Delivered to Resend account inbox ${allowedInbox} until domain is verified.`,
              ``,
              plainTextFromHtml(html, text),
            ].join('\n'),
            replyTo,
          },
          { allowRedirect: false }
        );
        return {
          ...redirected,
          intendedTo: intended,
          emailRedirectedTo: allowedInbox,
          redirected: true,
        };
      }
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
    deliveryTo: to,
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
  if (replyTo) payload.replyTo = { email: replyTo };

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
    sender: smtpUser || undefined,
    to,
    subject,
    html,
    text: plainTextFromHtml(html, text),
    replyTo: replyTo || smtpUser || undefined,
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
  const provider = resolveEmailProvider();
  activeProvider = provider;

  if (provider === 'none') {
    throw new Error(
      'No email provider configured. Set RESEND_API_KEY (recommended), BREVO_API_KEY, or SMTP_* in backend/.env'
    );
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

    lastSmtpError = null;
    logger.info(
      `Email sent via ${result.provider} to ${recipient}: "${subject}" id=${result.messageId}`
    );
    return result;
  } catch (err) {
    lastSmtpError = err.message;

    const isResendRecipientLimit = /only send testing emails to your own email/i.test(err.message);
    const forcedResend = String(env.EMAIL_PROVIDER || '').toLowerCase() === 'resend';

   
    if (forcedResend || isResendRecipientLimit) {
      resetTransporter();
      if (isResendRecipientLimit) {
        throw new Error(
          'Resend can only email your account address until you verify a domain. ' +
            'Go to https://resend.com/domains , add bicomworkspace.com, then set ' +
            'EMAIL_FROM="BIWORKSPACE <noreply@bicomworkspace.com>" so invites reach any user.'
        );
      }
      throw err;
    }

    if ((provider === 'resend' || provider === 'brevo') && isSmtpReady()) {
      logger.warn(`${provider} failed (${err.message}) — falling back to SMTP`);
      try {
        const fallback = await sendViaSmtp({ to: recipient, subject, html, text, replyTo });
        if (fallback?.logged) throw new Error(err.message);
        logger.info(
          `Email sent via smtp fallback to ${recipient}: "${subject}" id=${fallback.messageId}`
        );
        return fallback;
      } catch (smtpErr) {
        lastSmtpError = smtpErr.message;
        resetTransporter();
        throw new Error(`${provider} failed: ${err.message}; SMTP fallback failed: ${smtpErr.message}`);
      }
    }
    resetTransporter();
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
