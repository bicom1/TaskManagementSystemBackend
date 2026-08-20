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

function cleanSecret(value) {
  if (value == null) return value;
  const s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  if (/^[a-zA-Z0-9 ]{16,20}$/.test(s) && s.includes(' ')) {
    return s.replace(/\s+/g, '');
  }
  return s;
}

function resetTransporter() {
  transporter = null;
  smtpConfigured = false;
  activeProvider = null;
}

function parseFromAddress(fromValue) {
  const raw =
    fromValue ||
    env.EMAIL_FROM ||
    (env.SMTP_USER ? `BIWORKSPACE <${env.SMTP_USER}>` : 'BIWORKSPACE <onboarding@resend.dev>');
  const match = String(raw).match(/^(.*)<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, '') || 'BIWORKSPACE',
      email: match[2].trim(),
      formatted: raw,
    };
  }
  return { name: 'BIWORKSPACE', email: String(raw).trim(), formatted: `BIWORKSPACE <${raw}>` };
}

function plainTextFromHtml(html, fallbackText) {
  if (fallbackText) return fallbackText;
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

/** Prefer Resend → Brevo → SMTP for local + live deliverability */
function resolveEmailProvider() {
  const forced = String(env.EMAIL_PROVIDER || 'auto').trim().toLowerCase();
  const resendKey = cleanSecret(env.RESEND_API_KEY);
  const brevoKey = cleanSecret(env.BREVO_API_KEY);

  if (forced === 'resend' && resendKey) return 'resend';
  if (forced === 'brevo' && brevoKey) return 'brevo';
  if (forced === 'smtp') return 'smtp';

  if (resendKey) return 'resend';
  if (brevoKey) return 'brevo';
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return 'smtp';
  return 'none';
}

function getTransporter() {
  if (transporter) return transporter;

  const host = env.SMTP_HOST;
  const user = cleanSecret(env.SMTP_USER);
  const pass = cleanSecret(env.SMTP_PASS);
  const port = Number(env.SMTP_PORT) || 587;

  if (host && user && pass) {
    smtpConfigured = true;
    const isGmail = /gmail\.com$/i.test(host);
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user, pass },
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: isGmail,
      },
    });
    logger.info(`SMTP transporter configured (${host}:${port})`);
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

async function sendViaResend({ to, subject, html, text, replyTo }, { allowRedirect = true } = {}) {
  const apiKey = cleanSecret(env.RESEND_API_KEY);
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const fromInfo = parseFromAddress(
    env.EMAIL_FROM || 'BIWORKSPACE <onboarding@resend.dev>'
  );

  // Custom verified domain → always send to the real recipient inbox
  const usingVerifiedDomain = !/onboarding@resend\.dev$/i.test(fromInfo.email);

  const payload = {
    from: fromInfo.formatted.includes('<')
      ? fromInfo.formatted
      : `${fromInfo.name} <${fromInfo.email}>`,
    to: [to],
    subject,
    html,
    text: plainTextFromHtml(html, text),
  };
  if (replyTo) payload.reply_to = replyTo;

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

    // Only redirect when still on Resend's shared test sender (no verified domain yet)
    if (!usingVerifiedDomain && allowRedirect && match?.[1]) {
      const allowedInbox = String(match[1]).trim().toLowerCase();
      const intended = String(to).trim().toLowerCase();
      if (allowedInbox && intended !== allowedInbox) {
        logger.warn(
          `Resend test mode: redirecting email for ${intended} → ${allowedInbox} (verify domain later for direct delivery)`
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

  const fromInfo = parseFromAddress(
    env.EMAIL_FROM ||
      (env.SMTP_USER ? `BIWORKSPACE <${env.SMTP_USER}>` : null) ||
      'BIWORKSPACE <noreply@bicommunications.ae>'
  );

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

    // Do not fall back to unreliable cPanel SMTP when Resend is the chosen provider —
    // that "succeeds" on the server but often never reaches Gmail inboxes.
    if (forcedResend || isResendRecipientLimit) {
      resetTransporter();
      if (isResendRecipientLimit) {
        throw new Error(
          'Resend can only email your account address until you verify a domain. ' +
            'Go to https://resend.com/domains , add bicommunications.ae, then set ' +
            'EMAIL_FROM=BIWORKSPACE <tasksmtp@bicommunications.ae> so invites reach any user.'
        );
      }
      throw err;
    }

    if ((provider === 'resend' || provider === 'brevo') && env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
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
    lastSmtpError = null;
    return {
      ok: true,
      reason: 'Resend API key configured',
      provider: 'resend',
      user: parseFromAddress(env.EMAIL_FROM || 'BIWORKSPACE <onboarding@resend.dev>').email,
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
