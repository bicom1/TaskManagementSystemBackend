/**
 * Upsert key live accounts without wiping the database.
 * - Super Admin: ibrahim@bicommunications.ae
 * - Development Team Lead: ibrahimimraniu@gmail.com
 *
 * Usage: npm run seed:key-accounts
 *
 * Always force-hashes passwords (markModified) so email/password login works.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const Department = require('../models/department.model');
const Team = require('../models/team.model');
const { ROLES, DEPARTMENT_CODES } = require('../constants/roles.constant');

const SUPER_ADMIN = {
  email: (process.env.SEED_SUPER_ADMIN_EMAIL || 'ibrahim@bicommunications.ae')
    .toLowerCase()
    .trim(),
  password: process.env.SEED_SUPER_ADMIN_PASSWORD || 'Ibrahim@Admin123',
  name: process.env.SEED_SUPER_ADMIN_NAME || 'Ibrahim',
  jobTitle: 'Super Admin',
};

const DEV_LEAD = {
  email: (process.env.SEED_DEV_LEAD_EMAIL || 'ibrahimimraniu@gmail.com')
    .toLowerCase()
    .trim(),
  password: process.env.SEED_DEV_LEAD_PASSWORD || 'Ibrahim@Lead123',
  name: process.env.SEED_DEV_LEAD_NAME || 'Ibrahim Imran',
  jobTitle: 'Development Team Lead',
};

async function upsertLocalUser({ email, password, name, role, jobTitle, department }) {
  let user = await User.findOne({ email }).select('+password');
  const created = !user;
  if (user) {
    user.name = name;
    user.role = role;
    user.jobTitle = jobTitle;
    user.password = password;
    user.markModified('password'); // force bcrypt hash even if value looks unchanged
    user.isActive = true;
    user.invitePending = false;
    user.authProvider = 'local';
    if (department) user.department = department;
    await user.save();
  } else {
    user = await User.create({
      name,
      email,
      password,
      role,
      jobTitle,
      department: department || null,
      authProvider: 'local',
      isActive: true,
      invitePending: false,
    });
  }

  // Verify login will succeed with the intended password
  const fresh = await User.findById(user._id).select('+password');
  const ok = await fresh.comparePassword(password);
  if (!ok) {
    throw new Error(`Password verify failed for ${email} — login would not work`);
  }
  if (!/^\$2[aby]\$/.test(fresh.password || '')) {
    throw new Error(`Password was not bcrypt-hashed for ${email}`);
  }

  return { user: fresh, created };
}

async function ensureDevelopmentDept() {
  let dept = await Department.findOne({ code: DEPARTMENT_CODES.DEVELOPMENT });
  if (dept) return dept;

  dept = await Department.create({
    code: DEPARTMENT_CODES.DEVELOPMENT,
    name: 'Development',
    description: 'Software engineering',
  });
  return dept;
}

async function ensureDevTeam(dept, leadUser) {
  let team =
    (await Team.findOne({ department: dept._id, lead: leadUser._id })) ||
    (await Team.findOne({ department: dept._id, name: /platform|development|engineering/i })) ||
    (await Team.findOne({ department: dept._id }).sort({ createdAt: 1 }));

  if (!team) {
    team = await Team.create({
      name: 'Platform Engineering',
      description: 'Core product development',
      department: dept._id,
      lead: leadUser._id,
      members: [leadUser._id],
    });
    return { team, created: true };
  }

  team.lead = leadUser._id;
  const memberIds = new Set((team.members || []).map((id) => String(id)));
  memberIds.add(String(leadUser._id));
  team.members = [...memberIds];
  await team.save();
  return { team, created: false };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set a real MONGO_URI in backend/.env before running.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Ensuring key accounts (with login-ready passwords)…');

  const { user: superAdmin } = await upsertLocalUser({
    ...SUPER_ADMIN,
    role: ROLES.SUPER_ADMIN,
  });
  console.log(`Super Admin ready: ${SUPER_ADMIN.email} (${superAdmin.role})`);

  const devDept = await ensureDevelopmentDept();
  const { user: devLead } = await upsertLocalUser({
    ...DEV_LEAD,
    role: ROLES.TEAM_LEAD,
    department: devDept._id,
  });
  console.log(`Dev Team Lead ready: ${DEV_LEAD.email} (${devLead.role})`);

  if (!devDept.head) {
    devDept.head = devLead._id;
    await devDept.save();
  }

  const { team } = await ensureDevTeam(devDept, devLead);
  console.log(`Team ready: "${team.name}"`);

  // Smoke-test AuthService.login the same way the API does
  const authService = require('../services/auth.service');
  for (const account of [
    { email: SUPER_ADMIN.email, password: SUPER_ADMIN.password, label: 'Super Admin' },
    { email: DEV_LEAD.email, password: DEV_LEAD.password, label: 'Dev Team Lead' },
  ]) {
    const result = await authService.login(account);
    console.log(`Login OK — ${account.label}: ${result.user.email} / ${result.user.role}`);
  }

  console.log('\n—— Share these logins ——');
  console.log(
    JSON.stringify(
      {
        superAdmin: {
          email: SUPER_ADMIN.email,
          password: SUPER_ADMIN.password,
          role: ROLES.SUPER_ADMIN,
        },
        developmentTeamLead: {
          email: DEV_LEAD.email,
          password: DEV_LEAD.password,
          role: ROLES.TEAM_LEAD,
          jobTitle: DEV_LEAD.jobTitle,
          team: team.name,
        },
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
