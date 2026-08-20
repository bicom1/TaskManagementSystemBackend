/**
 * Upsert key live accounts without wiping the database.
 * - Super Admin: ibrahim@bicommunications.ae
 * - Development Team Lead: ibrahimimraniu@gmail.com
 *
 * Usage: npm run seed:key-accounts
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
  if (user) {
    user.name = name;
    user.role = role;
    user.jobTitle = jobTitle;
    user.password = password;
    user.isActive = true;
    user.invitePending = false;
    user.authProvider = 'local';
    if (department) user.department = department;
    await user.save();
    return { user, created: false };
  }

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
  return { user, created: true };
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
  console.log('Connected. Ensuring key accounts…');

  const { user: superAdmin, created: saCreated } = await upsertLocalUser({
    ...SUPER_ADMIN,
    role: ROLES.SUPER_ADMIN,
  });
  console.log(
    `${saCreated ? 'Created' : 'Updated'} Super Admin: ${SUPER_ADMIN.email}`
  );

  const devDept = await ensureDevelopmentDept();
  const { user: devLead, created: leadCreated } = await upsertLocalUser({
    ...DEV_LEAD,
    role: ROLES.TEAM_LEAD,
    department: devDept._id,
  });
  console.log(
    `${leadCreated ? 'Created' : 'Updated'} Development Team Lead: ${DEV_LEAD.email}`
  );

  // Prefer this lead as department contact when none set
  if (!devDept.head) {
    devDept.head = devLead._id;
    await devDept.save();
  }

  const { team, created: teamCreated } = await ensureDevTeam(devDept, devLead);
  console.log(
    `${teamCreated ? 'Created' : 'Updated'} team "${team.name}" with lead ${DEV_LEAD.email}`
  );

  console.log('\n—— Share these logins ——');
  console.log(
    JSON.stringify(
      {
        superAdmin: {
          email: SUPER_ADMIN.email,
          password: SUPER_ADMIN.password,
          role: ROLES.SUPER_ADMIN,
          name: SUPER_ADMIN.name,
        },
        developmentTeamLead: {
          email: DEV_LEAD.email,
          password: DEV_LEAD.password,
          role: ROLES.TEAM_LEAD,
          jobTitle: DEV_LEAD.jobTitle,
          name: DEV_LEAD.name,
          department: 'Development',
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
