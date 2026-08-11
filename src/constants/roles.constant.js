const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  DEPT_HEAD: 'dept_head',
  TEAM_LEAD: 'team_lead',
  EXECUTIVE: 'executive',
  EMPLOYEE: 'employee',
});

const ROLE_VALUES = Object.values(ROLES);

const ROLE_LABELS = Object.freeze({
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.DEPT_HEAD]: 'Department Head',
  [ROLES.TEAM_LEAD]: 'Team Lead',
  [ROLES.EXECUTIVE]: 'Executive',
  [ROLES.EMPLOYEE]: 'Employee',
});

/** Rank for approval / permission comparisons (higher = more authority) */
const ROLE_RANK = Object.freeze({
  [ROLES.EMPLOYEE]: 1,
  [ROLES.EXECUTIVE]: 2,
  [ROLES.TEAM_LEAD]: 3,
  [ROLES.DEPT_HEAD]: 4,
  [ROLES.SUPER_ADMIN]: 5,
});

const DEPARTMENT_CODES = Object.freeze({
  SEO: 'seo',
  DEVELOPMENT: 'development',
  DESIGNING: 'designing',
});

/** Built-in presets — new departments may use any unique lowercase code */
const DEPARTMENT_CODE_VALUES = Object.values(DEPARTMENT_CODES);

const DEPARTMENT_PRESETS = Object.freeze([
  {
    code: DEPARTMENT_CODES.SEO,
    name: 'SEO',
    description: 'Search engine optimization — Head, Team Leads, Executives, Employees',
  },
  {
    code: DEPARTMENT_CODES.DEVELOPMENT,
    name: 'Development',
    description: 'Software development — Team Leads and Employees',
  },
  {
    code: DEPARTMENT_CODES.DESIGNING,
    name: 'UI/UX Designing',
    description: 'Product design — Team Leads and Employees',
  },
]);

/**
 * Roles allowed per department (invite matrix).
 * SEO: Head + TL + Executive + Employee
 * Development / UI-UX: Team Lead + Employee only
 */
const DEPARTMENT_ALLOWED_ROLES = Object.freeze({
  [DEPARTMENT_CODES.SEO]: [
    ROLES.DEPT_HEAD,
    ROLES.TEAM_LEAD,
    ROLES.EXECUTIVE,
    ROLES.EMPLOYEE,
  ],
  [DEPARTMENT_CODES.DEVELOPMENT]: [ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [DEPARTMENT_CODES.DESIGNING]: [ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
});

/** Invite-facing role labels (dept-aware) */
const INVITE_ROLE_LABELS = Object.freeze({
  [DEPARTMENT_CODES.SEO]: {
    [ROLES.DEPT_HEAD]: 'SEO Head',
    [ROLES.TEAM_LEAD]: 'Team Lead',
    [ROLES.EXECUTIVE]: 'Executive',
    [ROLES.EMPLOYEE]: 'Employee',
  },
  [DEPARTMENT_CODES.DEVELOPMENT]: {
    [ROLES.TEAM_LEAD]: 'Team Lead',
    [ROLES.EMPLOYEE]: 'Employee',
  },
  [DEPARTMENT_CODES.DESIGNING]: {
    [ROLES.TEAM_LEAD]: 'Team Lead',
    [ROLES.EMPLOYEE]: 'Employee',
  },
});

/** Suggested job titles by department + role */
const JOB_TITLE_SUGGESTIONS = Object.freeze({
  [DEPARTMENT_CODES.SEO]: {
    [ROLES.DEPT_HEAD]: ['SEO Head', 'Head of SEO'],
    [ROLES.TEAM_LEAD]: ['SEO Team Lead', 'SEO Lead'],
    [ROLES.EXECUTIVE]: ['SEO Executive', 'SEO Specialist'],
    [ROLES.EMPLOYEE]: ['SEO Analyst', 'SEO Associate', 'Content SEO'],
  },
  [DEPARTMENT_CODES.DEVELOPMENT]: {
    [ROLES.TEAM_LEAD]: ['Development Team Lead', 'Engineering Lead', 'Tech Lead'],
    [ROLES.EMPLOYEE]: [
      'Software Developer',
      'Frontend Developer',
      'Backend Developer',
      'Full Stack Developer',
    ],
  },
  [DEPARTMENT_CODES.DESIGNING]: {
    [ROLES.TEAM_LEAD]: ['UI/UX Team Lead', 'Design Lead'],
    [ROLES.EMPLOYEE]: ['UI/UX Designer', 'Product Designer', 'Visual Designer'],
  },
});

function canManageOrg(role) {
  return role === ROLES.SUPER_ADMIN;
}

function canApproveTasks(role) {
  return (
    role === ROLES.SUPER_ADMIN ||
    role === ROLES.DEPT_HEAD ||
    role === ROLES.TEAM_LEAD
  );
}

function isLeadOrAbove(role) {
  return (ROLE_RANK[role] || 0) >= ROLE_RANK[ROLES.TEAM_LEAD];
}

/** Normalize custom department codes for scalability */
function normalizeDepartmentCode(code) {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 50);
}

function getAllowedRolesForDepartment(deptCode) {
  const code = normalizeDepartmentCode(deptCode);
  return DEPARTMENT_ALLOWED_ROLES[code]
    ? [...DEPARTMENT_ALLOWED_ROLES[code]]
    : [ROLES.TEAM_LEAD, ROLES.EMPLOYEE];
}

function isRoleAllowedForDepartment(deptCode, role) {
  if (!deptCode) return true;
  const code = normalizeDepartmentCode(deptCode);
  // Custom / unknown departments accept any non-system role
  if (!DEPARTMENT_ALLOWED_ROLES[code]) return true;
  return DEPARTMENT_ALLOWED_ROLES[code].includes(role);
}

function getInviteRoleLabel(deptCode, role) {
  const code = normalizeDepartmentCode(deptCode);
  return (
    INVITE_ROLE_LABELS[code]?.[role] ||
    ROLE_LABELS[role] ||
    String(role || '').replace(/_/g, ' ')
  );
}

function getJobTitleSuggestions(deptCode, role) {
  const code = normalizeDepartmentCode(deptCode);
  return JOB_TITLE_SUGGESTIONS[code]?.[role]
    ? [...JOB_TITLE_SUGGESTIONS[code][role]]
    : [];
}

function getDefaultJobTitle(deptCode, role) {
  const list = getJobTitleSuggestions(deptCode, role);
  return list[0] || '';
}

module.exports = {
  ROLES,
  ROLE_VALUES,
  ROLE_LABELS,
  ROLE_RANK,
  DEPARTMENT_CODES,
  DEPARTMENT_CODE_VALUES,
  DEPARTMENT_PRESETS,
  DEPARTMENT_ALLOWED_ROLES,
  INVITE_ROLE_LABELS,
  JOB_TITLE_SUGGESTIONS,
  canManageOrg,
  canApproveTasks,
  isLeadOrAbove,
  normalizeDepartmentCode,
  getAllowedRolesForDepartment,
  isRoleAllowedForDepartment,
  getInviteRoleLabel,
  getJobTitleSuggestions,
  getDefaultJobTitle,
};
