const http = require('http');

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 5000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const login = await request('POST', '/api/v1/auth/login', {
    email: 'admin@hp.local',
    password: 'Admin1234',
  });
  const token = login.body?.data?.accessToken;
  if (!token) throw new Error('login failed');

  const email = `invitee${Date.now()}@hp.local`;
  const invite = await request(
    'POST',
    '/api/v1/users/invite',
    { email, name: 'Invite Test', role: 'member' },
    token
  );
  console.log('invite status', invite.status);
  console.log('invite user', invite.body?.data?.user?.email, invite.body?.data?.user?.invitePending);
  console.log('temp password present', Boolean(invite.body?.data?.temporaryPassword));

  const users = await request('GET', '/api/v1/users', null, token);
  console.log('users count', users.body?.data?.length);
  console.log('INVITE_OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
