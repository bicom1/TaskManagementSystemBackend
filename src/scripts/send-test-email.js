/**
 * Test email delivery with the configured provider (Resend / Brevo / SMTP).
 * Usage: node src/scripts/send-test-email.js you@example.com
 */
require('dotenv').config();

const {
  verifyEmailConnection,
  sendMail,
  resetTransporter,
  getActiveEmailProvider,
} = require('../emails/mailer.util');
const { inviteEmail } = require('../emails/templates');
const env = require('../config/env');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node src/scripts/send-test-email.js you@example.com');
    process.exit(1);
  }

  resetTransporter();
  const check = await verifyEmailConnection();
  console.log('Provider:', getActiveEmailProvider());
  console.log('Status:', check.ok ? 'OK' : 'FAIL', check.reason);
  if (!check.ok) {
    console.error('\nAdd RESEND_API_KEY to backend/.env (https://resend.com), then retry.');
    process.exit(1);
  }

  const result = await sendMail({
    to,
    subject: 'BIWORKSPACE delivery test',
    html: inviteEmail({
      recipientName: 'Test User',
      inviterName: 'BIWORKSPACE Admin',
      temporaryPassword: 'TestPass123',
      loginUrl: `${env.CLIENT_URL}/login`,
      acceptUrl: `${env.CLIENT_URL}/accept-invite?token=test`,
      emailTo: to,
    }),
    text: `BIWORKSPACE delivery test via ${getActiveEmailProvider()} to ${to}.`,
  });

  console.log('Sent via:', result.provider);
  console.log('messageId:', result.messageId);
  console.log('From:', result.from);
  console.log('\nCheck inbox AND spam for:', to);
}

main().catch((err) => {
  console.error('SEND FAILED:', err.message);
  process.exit(1);
});
