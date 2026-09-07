/**
 * Verifies the Postman failure root-causes are fixed on the API.
 * Usage: node src/scripts/smoke-collection-fixes.js
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
            /* keep */
          }
          resolve({ status: res.statusCode, body: parsed });
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
  const login = await request('POST', '/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
  assert(login.status === 200, `login ${login.status}`);
  const token = login.body.data.accessToken;
  const refreshToken = login.body.data.refreshToken;
  assert(token && refreshToken, 'tokens missing');

  // C – refresh with body
  const refreshed = await request('POST', '/api/v1/auth/refresh', { refreshToken });
  assert(refreshed.status === 200, `refresh ${refreshed.status} ${JSON.stringify(refreshed.body)}`);
  const access = refreshed.body.data.accessToken;

  // C – google/exchange without code → 400 (route exists)
  const exchange = await request('POST', '/api/v1/auth/google/exchange', {});
  assert(exchange.status === 400, `google/exchange should 400 without code, got ${exchange.status}`);

  // L – malformed ObjectId → 400 not 500
  const cast = await request('GET', '/api/v1/tasks/not-an-objectid', null, access);
  assert(cast.status === 400, `cast expected 400 got ${cast.status} ${cast.body?.message}`);

  // D – wrong password → 400
  const badPw = await request(
    'PATCH',
    '/api/v1/users/me/password',
    { currentPassword: 'DefinitelyWrong1', newPassword: 'Ibrahim@Admin123' },
    access
  );
  assert(badPw.status === 400, `wrong password expected 400 got ${badPw.status}`);

  // D – correct password change (same password is ok if rules pass)
  const goodPw = await request(
    'PATCH',
    '/api/v1/users/me/password',
    { currentPassword: PASSWORD, newPassword: PASSWORD },
    access
  );
  assert(goodPw.status === 200, `password change ${goodPw.status} ${JSON.stringify(goodPw.body)}`);

  // Seed IDs
  const projects = await request('GET', '/api/v1/projects?limit=5', null, access);
  assert(projects.status === 200, 'projects list');
  let projectId = (projects.body.data || [])[0]?._id;
  const teams = await request('GET', '/api/v1/teams?limit=5', null, access);
  const teamId = (teams.body.data || [])[0]?._id;
  assert(teamId, 'need a team');

  if (!projectId) {
    const created = await request(
      'POST',
      '/api/v1/projects',
      {
        name: `Smoke Project ${Date.now()}`,
        team: teamId,
        kind: 'list',
      },
      access
    );
    assert(created.status === 201 || created.status === 200, `create project ${created.status}`);
    projectId = created.body.data?._id || created.body.data?.id;
  }
  assert(projectId, 'projectId missing');

  // A/B – create task with live projectId
  const task = await request(
    'POST',
    '/api/v1/tasks',
    { title: `Smoke task ${Date.now()}`, project: projectId, status: 'todo' },
    access
  );
  assert(task.status === 201 || task.status === 200, `create task ${task.status} ${JSON.stringify(task.body)}`);
  const taskId = task.body.data?._id;
  assert(taskId, 'taskId missing');

  const board = await request('GET', `/api/v1/tasks/board/${projectId}`, null, access);
  assert(board.status === 200, `board ${board.status}`);

  const getTask = await request('GET', `/api/v1/tasks/${taskId}`, null, access);
  assert(getTask.status === 200, `get task ${getTask.status}`);

  // F – chat dm + project
  const users = await request('GET', '/api/v1/users?limit=10', null, access);
  const other = (users.body.data || []).find((u) => String(u._id) !== String(login.body.data.user._id));
  assert(other?._id, 'need another user for DM');
  const dm = await request('POST', '/api/v1/chat/dm', { userId: other._id }, access);
  assert(dm.status === 200, `dm ${dm.status} ${JSON.stringify(dm.body)}`);
  const pchat = await request('POST', '/api/v1/chat/project', { projectId }, access);
  assert(pchat.status === 200, `project chat ${pchat.status} ${JSON.stringify(pchat.body)}`);

  // G – unique department
  const code = `QA${String(Date.now()).slice(-6)}`;
  const dept = await request(
    'POST',
    '/api/v1/departments',
    { name: `Dept ${code}`, code },
    access
  );
  assert([200, 201].includes(dept.status), `dept ${dept.status} ${JSON.stringify(dept.body)}`);

  // I – invite returns token
  const inviteEmail = `invite${Date.now()}@test.local`;
  const invite = await request(
    'POST',
    '/api/v1/users/invite',
    { email: inviteEmail, name: 'Invite Smoke', role: 'employee', department: dept.body.data?._id },
    access
  );
  assert([200, 201].includes(invite.status), `invite ${invite.status} ${JSON.stringify(invite.body)}`);
  const inviteToken = invite.body.data?.inviteToken;
  assert(inviteToken, 'inviteToken missing from invite response');
  const preview = await request(
    'GET',
    `/api/v1/users/invite/preview?token=${encodeURIComponent(inviteToken)}`,
    null,
    null
  );
  assert(preview.status === 200, `invite preview ${preview.status}`);

  // K – meeting with attendees
  const meeting = await request(
    'POST',
    '/api/v1/workspace/meetings',
    {
      title: `Smoke meet ${Date.now()}`,
      startsAt: new Date(Date.now() + 3600000).toISOString(),
      endsAt: new Date(Date.now() + 7200000).toISOString(),
      attendees: [other._id],
    },
    access
  );
  assert([200, 201].includes(meeting.status), `meeting ${meeting.status} ${JSON.stringify(meeting.body)}`);

  // Home personal + recents with real ids
  const personal = await request('POST', '/api/v1/home/personal-list', { taskId }, access);
  assert([200, 201].includes(personal.status), `personal ${personal.status}`);
  const recent = await request(
    'POST',
    '/api/v1/home/recents',
    { type: 'task', refId: taskId, title: 'Smoke', projectId },
    access
  );
  assert([200, 201].includes(recent.status), `recent ${recent.status}`);

  // E – AI reachable (2xx or billing/rate-limit)
  const ai = await request('POST', '/api/v1/ai/chat', { message: 'ping', model: 'fast' }, access);
  assert(
    [200, 429, 503].includes(ai.status),
    `ai unexpected ${ai.status} ${JSON.stringify(ai.body)}`
  );
  console.log('ai status', ai.status, ai.body?.message || 'ok');

  // Reports with live projectId
  const summary = await request('GET', `/api/v1/reports/project/${projectId}/summary`, null, access);
  assert(summary.status === 200, `summary ${summary.status}`);

  console.log('ALL_COLLECTION_ROOT_CAUSES_OK');
})().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
