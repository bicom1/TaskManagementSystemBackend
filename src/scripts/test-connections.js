/**
 * Quick connectivity check for Upstash Redis + email provider.
 * Run: node src/scripts/test-connections.js [email@example.com]
 */
require('dotenv').config();

const { verifyRedisConnection } = require('../config/redis');
const {
  verifyEmailConnection,
  sendMail,
  getActiveEmailProvider,
} = require('../emails/mailer.util');
const { inviteEmail } = require('../emails/templates');
const env = require('../config/env');

async function main() {
  console.log('--- Redis (Upstash REST) ---');
  const redis = await verifyRedisConnection();
  console.log(redis.ok ? 'OK' : 'FAIL', redis.reason);

  console.log('\n--- Email ---');
  const email = await verifyEmailConnection();
  console.log(email.ok ? 'OK' : 'FAIL', `(${email.provider || getActiveEmailProvider()})`, email.reason);

  const testTo = process.argv[2];
  if (testTo && email.ok) {
    console.log(`\n--- Sending test invite email to ${testTo} ---`);
    const result = await sendMail({
      to: testTo,
      subject: 'BIWORKSPACE invite test',
      html: inviteEmail({
        recipientName: 'Test User',
        inviterName: 'BIWORKSPACE Admin',
        temporaryPassword: 'TestPass123',
        loginUrl: `${env.CLIENT_URL}/login`,
        emailTo: testTo,
      }),
    });
    console.log('Test email sent via', result.provider, result.messageId);
  }

  process.exit(redis.ok && email.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
