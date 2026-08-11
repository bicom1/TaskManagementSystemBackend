require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const Department = require('../models/department.model');
const Team = require('../models/team.model');
const Project = require('../models/project.model');
const Task = require('../models/task.model');
const Message = require('../models/message.model');
const { ROLES, DEPARTMENT_CODES } = require('../constants/roles.constant');
const { APPROVAL_STATUS } = Task;

async function seed() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<db_password>')) {
    console.error('Set a real MONGO_URI in backend/.env before seeding.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Seeding org hierarchy…');

  await Promise.all([
    Message.deleteMany({}),
    Task.deleteMany({}),
    Project.deleteMany({}),
    Team.deleteMany({}),
    Department.deleteMany({}),
    User.deleteMany({}),
    require('../models/comment.model').deleteMany({}),
    require('../models/notification.model').deleteMany({}),
    require('../models/meeting.model').deleteMany({}),
    require('../models/location.model').deleteMany({}),
  ]);

  const superAdmin = await User.create({
    name: 'Super Admin',
    email: 'admin@hp.local',
    password: 'Admin1234',
    role: ROLES.SUPER_ADMIN,
    jobTitle: 'Super Admin',
  });

  // ——— SEO ———
  const seoDept = await Department.create({
    code: DEPARTMENT_CODES.SEO,
    name: 'SEO',
    description: 'Search engine optimization department',
  });

  const seoHead = await User.create({
    name: 'Sara Head',
    email: 'seo.head@hp.local',
    password: 'Lead1234',
    role: ROLES.DEPT_HEAD,
    jobTitle: 'SEO Head',
    department: seoDept._id,
  });
  seoDept.head = seoHead._id;
  await seoDept.save();

  const seoLead = await User.create({
    name: 'Sam Lead',
    email: 'seo.lead@hp.local',
    password: 'Lead1234',
    role: ROLES.TEAM_LEAD,
    jobTitle: 'SEO Team Lead',
    department: seoDept._id,
  });

  const seoExec = await User.create({
    name: 'Eva Executive',
    email: 'seo.exec@hp.local',
    password: 'Member1234',
    role: ROLES.EXECUTIVE,
    jobTitle: 'SEO Executive',
    department: seoDept._id,
  });

  const seoEmp = await User.create({
    name: 'Eli Employee',
    email: 'seo.emp@hp.local',
    password: 'Member1234',
    role: ROLES.EMPLOYEE,
    jobTitle: 'SEO Specialist',
    department: seoDept._id,
  });

  const seoTeam = await Team.create({
    name: 'Organic Search',
    description: 'On-page and content SEO',
    department: seoDept._id,
    lead: seoLead._id,
    members: [seoLead._id, seoExec._id, seoEmp._id],
  });

  // ——— Development ———
  const devDept = await Department.create({
    code: DEPARTMENT_CODES.DEVELOPMENT,
    name: 'Development',
    description: 'Software engineering',
  });

  const devLead = await User.create({
    name: 'Dana Lead',
    email: 'dev.lead@hp.local',
    password: 'Lead1234',
    role: ROLES.TEAM_LEAD,
    jobTitle: 'Development Team Lead',
    department: devDept._id,
  });
  devDept.head = devLead._id;
  await devDept.save();

  const developer = await User.create({
    name: 'Dev User',
    email: 'dev.user@hp.local',
    password: 'Member1234',
    role: ROLES.EMPLOYEE,
    jobTitle: 'Developer',
    department: devDept._id,
  });

  const devTeam = await Team.create({
    name: 'Platform Engineering',
    description: 'Core product development',
    department: devDept._id,
    lead: devLead._id,
    members: [devLead._id, developer._id],
  });

  // ——— Designing ———
  const designDept = await Department.create({
    code: DEPARTMENT_CODES.DESIGNING,
    name: 'UI/UX Designing',
    description: 'Product and visual design',
  });

  const designLead = await User.create({
    name: 'Drew Lead',
    email: 'design.lead@hp.local',
    password: 'Lead1234',
    role: ROLES.TEAM_LEAD,
    jobTitle: 'Design Team Lead',
    department: designDept._id,
  });
  designDept.head = designLead._id;
  await designDept.save();

  const designer = await User.create({
    name: 'Dina Designer',
    email: 'design.user@hp.local',
    password: 'Member1234',
    role: ROLES.EMPLOYEE,
    jobTitle: 'UI/UX Designer',
    department: designDept._id,
  });

  const designTeam = await Team.create({
    name: 'Experience Design',
    description: 'UI/UX and design systems',
    department: designDept._id,
    lead: designLead._id,
    members: [designLead._id, designer._id],
  });

  // Projects per department team
  const seoProject = await Project.create({
    name: 'SEO Growth Q3',
    key: 'SEO',
    description: 'Organic traffic initiatives',
    team: seoTeam._id,
    owner: seoLead._id,
    members: [seoLead._id, seoExec._id, seoEmp._id, superAdmin._id],
    status: 'active',
  });

  const designProject = await Project.create({
    name: 'HP Design System',
    key: 'UX',
    description: 'UI/UX redesign for BIWORKSPACE',
    team: designTeam._id,
    owner: designLead._id,
    members: [designLead._id, designer._id, superAdmin._id],
    status: 'active',
  });

  const devProject = await Project.create({
    name: 'BIWORKSPACE Core',
    key: 'DEV',
    description: 'Platform features and APIs',
    team: devTeam._id,
    owner: devLead._id,
    members: [devLead._id, developer._id, superAdmin._id],
    status: 'active',
  });

  await Task.create([
    {
      key: 'SEO-1',
      title: 'Keyword research for printers',
      project: seoProject._id,
      status: 'todo',
      priority: 'high',
      assignees: [seoEmp._id],
      reporter: seoExec._id,
      dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      position: 1,
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: seoLead._id,
      approvedAt: new Date(),
    },
    {
      key: 'SEO-2',
      title: 'Draft meta titles for laptop hub',
      project: seoProject._id,
      status: 'backlog',
      priority: 'medium',
      assignees: [seoEmp._id],
      reporter: seoEmp._id,
      dueDate: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      position: 1,
      approvalStatus: APPROVAL_STATUS.PENDING,
    },
    {
      key: 'UX-1',
      title: 'Redesign sidebar navigation',
      project: designProject._id,
      status: 'in_progress',
      priority: 'urgent',
      assignees: [designer._id, superAdmin._id],
      reporter: designLead._id,
      dueDate: new Date(),
      position: 1,
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: designLead._id,
      approvedAt: new Date(),
    },
    {
      key: 'DEV-1',
      title: 'Build invite email flow',
      project: devProject._id,
      status: 'done',
      priority: 'high',
      assignees: [developer._id],
      reporter: devLead._id,
      position: 1,
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: devLead._id,
      approvedAt: new Date(),
    },
    {
      key: 'DEV-2',
      title: 'ClickUp-style Home dashboard',
      project: devProject._id,
      status: 'in_progress',
      priority: 'urgent',
      assignees: [superAdmin._id, developer._id],
      reporter: superAdmin._id,
      dueDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
      position: 2,
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: superAdmin._id,
      approvedAt: new Date(),
    },
    {
      key: 'DEV-3',
      title: 'Wire Socket.IO team chat',
      project: devProject._id,
      status: 'todo',
      priority: 'high',
      assignees: [superAdmin._id],
      reporter: superAdmin._id,
      dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      position: 3,
      approvalStatus: APPROVAL_STATUS.APPROVED,
      approvedBy: superAdmin._id,
      approvedAt: new Date(),
    },
  ]);

  await Project.findByIdAndUpdate(seoProject._id, { taskSequence: 2 });
  await Project.findByIdAndUpdate(designProject._id, { taskSequence: 1 });
  await Project.findByIdAndUpdate(devProject._id, { taskSequence: 3 });

  const homeTasks = await Task.find({ key: { $in: ['DEV-2', 'DEV-3', 'UX-1'] } });
  const personalIds = homeTasks.map((t) => t._id);
  await User.findByIdAndUpdate(superAdmin._id, {
    preferences: {
      personalList: personalIds.slice(0, 2),
      calendarProvider: 'none',
      homeCards: [],
      recentItems: [
        {
          type: 'project',
          refId: devProject._id,
          title: 'BIWORKSPACE Core',
          subtitle: 'in All Projects',
          projectId: devProject._id,
          at: new Date(),
        },
        {
          type: 'task',
          refId: homeTasks[0]?._id,
          title: homeTasks[0]?.title || 'Home dashboard',
          subtitle: 'in BIWORKSPACE Core',
          projectId: devProject._id,
          at: new Date(),
        },
      ],
    },
  });

  const Comment = require('../models/comment.model');
  const { NOTIFICATION_TYPES } = require('../constants/notification.constant');
  const Notification = require('../models/notification.model');

  if (homeTasks[0]) {
    await Comment.create({
      task: homeTasks[0]._id,
      author: developer._id,
      content: 'Started the ClickUp home cards — please review Recents and Agenda.',
    });
    await Notification.create({
      recipient: superAdmin._id,
      sender: developer._id,
      type: NOTIFICATION_TYPES.COMMENT_ADDED,
      message: 'Comment on ClickUp-style Home dashboard',
      entityType: 'Task',
      entityId: homeTasks[0]._id,
    });
  }

  const Location = require('../models/location.model');
  const Meeting = require('../models/meeting.model');

  const dubaiOffice = await Location.create({
    name: 'Dubai HQ — SIT Tower',
    address: 'Dubai Silicon Oasis',
    city: 'Dubai',
    type: 'office',
    team: devTeam._id,
    department: devDept._id,
    createdBy: superAdmin._id,
  });

  await Location.create({
    name: 'Remote — Pakistan',
    city: 'Islamabad',
    type: 'remote',
    team: seoTeam._id,
    department: seoDept._id,
    createdBy: superAdmin._id,
  });

  const meetStart = new Date();
  meetStart.setMinutes(meetStart.getMinutes() + 12);
  const meetEnd = new Date(meetStart);
  meetEnd.setHours(meetEnd.getHours() + 1);

  await Meeting.create({
    title: 'Design Sprint Feedback',
    description:
      'Reviewed prototype flows. Decision: ship home redesign this sprint. Action: Dev to wire Meetings AI hub. Action: Design to polish calendar preview.',
    startsAt: meetStart,
    endsAt: meetEnd,
    team: designTeam._id,
    department: designDept._id,
    project: designProject._id,
    location: dubaiOffice._id,
    organizer: superAdmin._id,
    attendees: [superAdmin._id, developer._id, devLead._id],
    meetingUrl: 'https://meet.google.com/biworkspace-design-sprint',
  });

  const standupStart = new Date();
  standupStart.setHours(standupStart.getHours() + 5);
  const standupEnd = new Date(standupStart);
  standupEnd.setHours(standupEnd.getHours() + 1);

  await Meeting.create({
    title: 'Platform standup',
    description: 'Daily sync for BIWORKSPACE Core. Blockers: SMTP app password; Redis healthy.',
    startsAt: standupStart,
    endsAt: standupEnd,
    team: devTeam._id,
    department: devDept._id,
    project: devProject._id,
    location: dubaiOffice._id,
    organizer: superAdmin._id,
    attendees: [superAdmin._id, developer._id, devLead._id],
    meetingUrl: 'https://meet.google.com/biworkspace-standup',
  });

  const pastStart = new Date();
  pastStart.setDate(pastStart.getDate() - 1);
  pastStart.setHours(14, 0, 0, 0);
  const pastEnd = new Date(pastStart);
  pastEnd.setHours(15, 0, 0, 0);

  await Meeting.create({
    title: 'Sprint planning',
    description:
      'Key decisions: prioritize Meetings hub and Teams invite flow. Action items: seed calendar events; connect preferences; AI summarize notes.',
    startsAt: pastStart,
    endsAt: pastEnd,
    team: devTeam._id,
    department: devDept._id,
    project: devProject._id,
    locationLabel: 'Remote',
    organizer: superAdmin._id,
    attendees: [superAdmin._id, developer._id, devLead._id],
    meetingUrl: 'https://meet.google.com/biworkspace-planning',
  });

  // Ensure admin is on Platform Engineering team for dynamic home channels
  await Team.findByIdAndUpdate(devTeam._id, { $addToSet: { members: superAdmin._id } });
  await Project.findByIdAndUpdate(devProject._id, { $addToSet: { members: superAdmin._id } });
  await User.findByIdAndUpdate(superAdmin._id, { department: devDept._id });

  await Message.create({
    from: seoEmp._id,
    to: seoLead._id,
    department: seoDept._id,
    team: seoTeam._id,
    subject: 'Access to keyword tool?',
    body: 'Can I get access to the keyword research tool for the printers campaign?',
    type: 'query',
  });

  console.log('Seed complete.\n');
  console.log('Accounts (password Lead1234 / Member1234 / Admin1234):');
  console.log('  Super Admin     admin@hp.local / Admin1234');
  console.log('  SEO Head        seo.head@hp.local / Lead1234');
  console.log('  SEO Team Lead   seo.lead@hp.local / Lead1234');
  console.log('  SEO Executive   seo.exec@hp.local / Member1234');
  console.log('  SEO Employee    seo.emp@hp.local / Member1234');
  console.log('  Dev Team Lead   dev.lead@hp.local / Lead1234');
  console.log('  Developer       dev.user@hp.local / Member1234');
  console.log('  Design Lead     design.lead@hp.local / Lead1234');
  console.log('  Designer        design.user@hp.local / Member1234');
  console.log('\nDepartments: SEO · Development · UI/UX Designing');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
