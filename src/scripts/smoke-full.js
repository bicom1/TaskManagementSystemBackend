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
  console.log('login', login.status, login.body?.data?.user?.role);

  const token = login.body?.data?.accessToken;
  if (!token) throw new Error('login failed');

  const email = `newuser${Date.now()}@test.local`;
  const register = await request('POST', '/api/v1/auth/register', {
    name: 'New Tester',
    email,
    password: 'Test1234',
  });
  console.log('register', register.status, register.body?.data?.user?.email);

  const teams = await request('GET', '/api/v1/teams?limit=50', null, token);
  console.log('teams', teams.status, teams.body?.data?.length);

  const reports = await request('GET', '/api/v1/reports/workspace', null, token);
  console.log(
    'workspace report',
    reports.status,
    'tasks=',
    reports.body?.data?.totals?.tasks,
    'projects=',
    reports.body?.data?.totals?.projects,
    'dept bars=',
    reports.body?.data?.byDepartment?.length
  );

  const projects = await request('GET', '/api/v1/projects', null, token);
  const pid = projects.body?.data?.[0]?._id;
  const summary = await request('GET', `/api/v1/reports/project/${pid}/summary`, null, token);
  console.log('project summary', summary.status, summary.body?.data?.totalTasks);

  console.log('ALL_OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
