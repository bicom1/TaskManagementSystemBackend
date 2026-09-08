/**
 * Canonical roles — SUPERADMIN | ADMIN | MEMBER only.
 * Legacy keys (SUPER_ADMIN, DEPT_HEAD, …) alias to the same string values
 * so existing comparisons continue to work after DB migration.
 */
const ROLES = Object.freeze({
  SUPERADMIN: 'SUPERADMIN',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',

  // Legacy aliases → canonical values
  SUPER_ADMIN: 'SUPERADMIN',
  DEPT_HEAD: 'ADMIN',
  TEAM_LEAD: 'ADMIN',
  EXECUTIVE: 'MEMBER',
  EMPLOYEE: 'MEMBER',
});

const ROLE_VALUES = Object.freeze([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER]);

const ROLE_LABELS = Object.freeze({
  [ROLES.SUPERADMIN]: 'Superadmin',
  [ROLES.ADMIN]: 'Admin',
  [ROLES.MEMBER]: 'Member',
});

const ROLE_RANK = Object.freeze({
  [ROLES.MEMBER]: 1,
  [ROLES.ADMIN]: 2,
  [ROLES.SUPERADMIN]: 3,
});

/** Map any historical role string → SUPERADMIN | ADMIN | MEMBER */
function normalizeRole(role) {
  const raw = String(role || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  const map = {
    SUPERADMIN: ROLES.SUPERADMIN,
    SUPER_ADMIN: ROLES.SUPERADMIN,
    SA: ROLES.SUPERADMIN,

    ADMIN: ROLES.ADMIN,
    DEPT_HEAD: ROLES.ADMIN,
    DEPARTMENT_HEAD: ROLES.ADMIN,
    TEAM_LEAD: ROLES.ADMIN,
    TEAMLEAD: ROLES.ADMIN,
    MANAGER: ROLES.ADMIN,
    LEAD: ROLES.ADMIN,

    MEMBER: ROLES.MEMBER,
    EMPLOYEE: ROLES.MEMBER,
    EXECUTIVE: ROLES.MEMBER,
    USER: ROLES.MEMBER,
  };

  if (map[raw]) return map[raw];

  const lower = String(role || '')
    .trim()
    .toLowerCase();
  const lowerMap = {
    superadmin: ROLES.SUPERADMIN,
    super_admin: ROLES.SUPERADMIN,
    admin: ROLES.ADMIN,
    dept_head: ROLES.ADMIN,
    team_lead: ROLES.ADMIN,
    manager: ROLES.ADMIN,
    member: ROLES.MEMBER,
    employee: ROLES.MEMBER,
    executive: ROLES.MEMBER,
    user: ROLES.MEMBER,
  };
  return lowerMap[lower] || ROLES.MEMBER;
}

const DEPARTMENT_CODES = Object.freeze({
  SEO: 'seo',
  DEVELOPMENT: 'development',
  DESIGNING: 'designing',
});

const DEPARTMENT_CODE_VALUES = Object.values(DEPARTMENT_CODES);

const DEPARTMENT_PRESETS = Object.freeze([
  {
    code: DEPARTMENT_CODES.SEO,
    name: 'SEO',
    description: 'Search engine optimization',
  },
  {
    code: DEPARTMENT_CODES.DEVELOPMENT,
    name: 'Development',
    description: 'Software development',
  },
  {
    code: DEPARTMENT_CODES.DESIGNING,
    name: 'UI/UX Designing',
    description: 'Product design',
  },
]);

/** Any of the three roles may be invited into any department */
const DEPARTMENT_ALLOWED_ROLES = Object.freeze({
  [DEPARTMENT_CODES.SEO]: [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER],
  [DEPARTMENT_CODES.DEVELOPMENT]: [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER],
  [DEPARTMENT_CODES.DESIGNING]: [ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER],
});

const INVITE_ROLE_LABELS = Object.freeze({
  [DEPARTMENT_CODES.SEO]: {
    [ROLES.SUPERADMIN]: 'Superadmin',
    [ROLES.ADMIN]: 'Admin',
    [ROLES.MEMBER]: 'Member',
  },
  [DEPARTMENT_CODES.DEVELOPMENT]: {
    [ROLES.SUPERADMIN]: 'Superadmin',
    [ROLES.ADMIN]: 'Admin',
    [ROLES.MEMBER]: 'Member',
  },
  [DEPARTMENT_CODES.DESIGNING]: {
    [ROLES.SUPERADMIN]: 'Superadmin',
    [ROLES.ADMIN]: 'Admin',
    [ROLES.MEMBER]: 'Member',
  },
});

const JOB_TITLE_SUGGESTIONS = Object.freeze({
  [DEPARTMENT_CODES.SEO]: {
    [ROLES.SUPERADMIN]: ['Superadmin'],
    [ROLES.ADMIN]: ['SEO Admin', 'SEO Manager'],
    [ROLES.MEMBER]: ['SEO Analyst', 'SEO Associate', 'Content SEO'],
  },
  [DEPARTMENT_CODES.DEVELOPMENT]: {
    [ROLES.SUPERADMIN]: ['Superadmin'],
    [ROLES.ADMIN]: ['Engineering Admin', 'Tech Admin'],
    [ROLES.MEMBER]: [
      'Software Developer',
      'Frontend Developer',
      'Backend Developer',
      'Full Stack Developer',
    ],
  },
  [DEPARTMENT_CODES.DESIGNING]: {
    [ROLES.SUPERADMIN]: ['Superadmin'],
    [ROLES.ADMIN]: ['Design Admin'],
    [ROLES.MEMBER]: ['UI/UX Designer', 'Product Designer', 'Visual Designer'],
  },
});

function canManageOrg(role) {
  return normalizeRole(role) === ROLES.SUPERADMIN;
}

function canApproveTasks(role) {
  const r = normalizeRole(role);
  return r === ROLES.SUPERADMIN || r === ROLES.ADMIN;
}

function isLeadOrAbove(role) {
  return (ROLE_RANK[normalizeRole(role)] || 0) >= ROLE_RANK[ROLES.ADMIN];
}

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
    : [ROLES.ADMIN, ROLES.MEMBER];
}

function isRoleAllowedForDepartment(deptCode, role) {
  if (!deptCode) return true;
  const code = normalizeDepartmentCode(deptCode);
  if (!DEPARTMENT_ALLOWED_ROLES[code]) return true;
  return DEPARTMENT_ALLOWED_ROLES[code].includes(normalizeRole(role));
}

function getInviteRoleLabel(deptCode, role) {
  const code = normalizeDepartmentCode(deptCode);
  const r = normalizeRole(role);
  return INVITE_ROLE_LABELS[code]?.[r] || ROLE_LABELS[r] || String(role || '').replace(/_/g, ' ');
}

function getJobTitleSuggestions(deptCode, role) {
  const code = normalizeDepartmentCode(deptCode);
  const r = normalizeRole(role);
  return JOB_TITLE_SUGGESTIONS[code]?.[r] ? [...JOB_TITLE_SUGGESTIONS[code][r]] : [];
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
  normalizeRole,
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
