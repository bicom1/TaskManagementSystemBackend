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
  const health = await request('GET', '/health');
  console.log('health', health.status, health.body.status);

  const login = await request('POST', '/api/v1/auth/login', {
    email: 'admin@hp.local',
    password: 'Admin1234',
  });
  if (!login.body?.data?.accessToken) {
    console.error('login failed', login.status, login.body);
    process.exit(1);
  }
  console.log('login ok', login.body.data.user.role);

  const token = login.body.data.accessToken;
  const projects = await request('GET', '/api/v1/projects', null, token);
  console.log('projects', projects.body.data?.length, projects.body.data?.[0]?.name);

  const projectId = projects.body.data[0]._id;
  const board = await request('GET', `/api/v1/tasks/board/${projectId}`, null, token);
  const cols = board.body.data || {};
  console.log(
    'board',
    Object.keys(cols).join(','),
    'done=',
    (cols.done || []).length,
    'todo=',
    (cols.todo || []).length
  );
  console.log('E2E API OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
