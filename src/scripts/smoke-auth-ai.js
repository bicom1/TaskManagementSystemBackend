/**
 * Smoke: login → authenticated routes → OpenAI chat.
 * Usage (from backend/): node src/scripts/smoke-auth-ai.js
 */
require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 5000;
const EMAIL =
  process.env.SMOKE_EMAIL ||
  process.env.SEED_SUPER_ADMIN_EMAIL ||
  'ibrahim@bicommunications.ae';
const PASSWORD =
  process.env.SMOKE_PASSWORD ||
  process.env.SEED_SUPER_ADMIN_PASSWORD ||
  'Ibrahim@Admin123';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = JSON.parse(raw || '{}');
          } catch {
            /* keep string */
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  console.log('— health —');
  const health = await request('GET', '/health');
  assert(health.status === 200, `health failed: ${health.status}`);
  console.log('OK', health.body);

  console.log('— login —', EMAIL);
  const login = await request('POST', '/api/v1/auth/login', {
    email: EMAIL,
    password: PASSWORD,
  });
  assert(login.status === 200, `login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const accessToken = login.body?.data?.accessToken;
  const refreshToken = login.body?.data?.refreshToken;
  assert(accessToken, 'missing accessToken');
  assert(refreshToken, 'missing refreshToken in body (needed for Postman)');
  console.log('OK role=', login.body?.data?.user?.role);

  console.log('— GET /users/me —');
  const me = await request('GET', '/api/v1/users/me', null, accessToken);
  assert(me.status === 200, `me failed: ${me.status} ${JSON.stringify(me.body)}`);
  console.log('OK', me.body?.data?.email || me.body?.email);

  console.log('— POST /auth/refresh (body) —');
  const refreshed = await request('POST', '/api/v1/auth/refresh', { refreshToken });
  assert(
    refreshed.status === 200,
    `refresh failed: ${refreshed.status} ${JSON.stringify(refreshed.body)}`
  );
  const nextToken = refreshed.body?.data?.accessToken;
  assert(nextToken, 'refresh did not return accessToken');
  console.log('OK refreshed');

  console.log('— OpenAI key present —', Boolean(process.env.OPENAI_API_KEY));
  assert(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY missing in backend/.env');

  console.log('— POST /ai/chat —');
  const ai = await request(
    'POST',
    '/api/v1/ai/chat',
    { message: 'Reply with exactly: pong', model: 'fast' },
    nextToken
  );
  assert(
    ai.status === 200,
    `ai failed: ${ai.status} ${JSON.stringify(ai.body)}`
  );
  console.log('OK model=', ai.body?.data?.model, 'reply=', String(ai.body?.data?.reply || '').slice(0, 80));

  console.log('ALL_OK');
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
