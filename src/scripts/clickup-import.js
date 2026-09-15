/**
 * Import a ClickUp export (made by clickup-export.js) into BIWORKSPACE.
 *
 *   node src/scripts/clickup-import.js --dir backups/clickup/2026-09-15            dry run — prints the plan
 *   node src/scripts/clickup-import.js --dir backups/clickup/2026-09-15 --apply    writes it
 *   node src/scripts/clickup-import.js --undo backups/clickup-import-<ts>.json --apply
 *
 * Options
 *   --db <name>            database name override (e.g. an isolated QA copy)
 *   --actor <email>        superadmin recorded as owner of imported projects (default: first superadmin)
 *   --lead <email>         lead of the imported teams (default: the ClickUp owner's account, else the actor)
 *   --department <name>    department that holds the imported teams (default: ClickUp workspace name)
 *   --alias a@x.com=b@y.com  treat ClickUp email a@x.com as the existing BIWORKSPACE user b@y.com (repeatable)
 *   --no-files             skip uploading attachments to Cloudinary
 *
 * Mapping: ClickUp space → team, list with tasks → project, task → task (subtasks, checklists,
 * dependencies, tags, estimates, tracked time, dates), comment + replies → comments, files → Cloudinary.
 * Members are matched by email; new ones become pending Google invites, people who left
 * ClickUp become deactivated accounts so their history keeps a name.
 *
 * Records are written straight to the models: no notifications, emails, sockets or activity rows.
 * Imported projects, tasks and comments carry external { source: 'clickup', id }, so a re-run skips
 * what already exists and only adds what is new. Every write is recorded in an undo file.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/user.model');
const Department = require('../models/department.model');
const Team = require('../models/team.model');
const Project = require('../models/project.model');
const Task = require('../models/task.model');
const Comment = require('../models/comment.model');
const { ROLES } = require('../constants/roles.constant');
const { TASK_STATUS, TASK_PRIORITY } = require('../constants/task.constant');
const { getWorkflowTemplate, generateProjectKey } = require('../constants/space.constant');

const SOURCE = 'clickup';
const STATUS_ORDER = [
  TASK_STATUS.BACKLOG,
  TASK_STATUS.TODO,
  TASK_STATUS.IN_PROGRESS,
  TASK_STATUS.IN_REVIEW,
  TASK_STATUS.DONE,
];
const DEFAULT_STATUS_COLOR = {
  backlog: '#9ca3af',
  todo: '#9ca3af',
  in_progress: '#7c3aed',
  in_review: '#f59e0b',
  done: '#22c55e',
};

/* ---------------------------------------------------------------- args ---- */

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const opts = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

const APPLY = has('--apply');
const WITH_FILES = !has('--no-files');

/* ------------------------------------------------------------- helpers ---- */

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};
const toDate = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : new Date(Number(v)));
const toHours = (ms) => (ms ? Math.round((Number(ms) / 3600000) * 100) / 100 : null);
const clip = (value, max) => {
  const s = String(value ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const lower = (s) => String(s || '').trim().toLowerCase();
const oid = () => new mongoose.Types.ObjectId();
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function slug(name) {
  return (
    lower(name)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'imported'
  );
}

/** ClickUp status → BIWORKSPACE status key. Status type is authoritative for open/closed. */
function mapStatus(status) {
  const name = lower(status?.status);
  const type = status?.type;
  if (type === 'closed' || type === 'done') return TASK_STATUS.DONE;
  if (/review|\bqa\b|testing|approv|feedback|verif/.test(name)) return TASK_STATUS.IN_REVIEW;
  if (/backlog|on hold|hold|paused|later|idea/.test(name)) return TASK_STATUS.BACKLOG;
  if (type === 'open' || /^(to ?do|open|new|pending|not started|planned|ready)$/.test(name)) {
    return TASK_STATUS.TODO;
  }
  return TASK_STATUS.IN_PROGRESS;
}

function mapPriority(priority) {
  const p = lower(priority?.priority);
  if (p === 'urgent') return TASK_PRIORITY.URGENT;
  if (p === 'high') return TASK_PRIORITY.HIGH;
  if (p === 'low') return TASK_PRIORITY.LOW;
  return TASK_PRIORITY.MEDIUM; // normal, or no priority set
}

const CLICKUP_ROLE = { 1: 'owner', 2: 'admin', 3: 'member', 4: 'guest' };

/* -------------------------------------------------------------- export ---- */

function loadExport(dir) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const tasks = [];
  const missing = [];
  for (const id of manifest.taskIds) {
    const file = path.join(dir, 'tasks', `${id}.json`);
    if (fs.existsSync(file)) tasks.push(readJson(file));
    else missing.push(id);
  }
  return { manifest, tasks, missing };
}

/** Attachment/image parts inside a comment. Image parts put the mime type in `extension`. */
function commentFileParts(comment) {
  return (comment.comment || [])
    .map((part) => {
      const a = part.type === 'attachment' ? part.attachment : part.type === 'image' ? part.image : null;
      if (!a) return null;
      const ext = String(a.extension || '');
      return {
        id: a.id,
        name: a.title || a.name,
        localFile: a.localFile,
        mimetype: a.mimetype || (ext.includes('/') ? ext : null),
        extension: ext.includes('/') ? a.type : ext,
      };
    })
    .filter(Boolean);
}

/** ClickUp table embed → rows of "cell | cell". */
function tableToText(table) {
  const cells = table?.cells || {};
  const rows = (table?.rows || []).length;
  const cols = (table?.columns || []).length;
  const lines = [];
  for (let r = 1; r <= rows; r++) {
    const row = [];
    for (let c = 1; c <= cols; c++) {
      const content = cells[`${r}:${c}`]?.content || [];
      row.push(
        content
          .map(({ insert }) => (typeof insert === 'string' ? insert : insert?.link_mention?.url || insert?.bookmark?.url || ''))
          .join('')
          .replace(/\s+/g, ' ')
          .trim()
      );
    }
    if (row.some(Boolean)) lines.push(row.join(' | '));
  }
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

/**
 * Comment text from its structured parts. ClickUp's own comment_text drops "https://"
 * from bookmarks and link mentions and prints tables as "undefined".
 */
function commentToText(comment) {
  const parts = comment.comment || [];
  if (!parts.length) return String(comment.comment_text || '').trim();
  return parts
    .map((p) => {
      switch (p.type) {
        case 'tag':
          return p.text || `@${p.user?.username || ''}`;
        case 'bookmark':
          return p.bookmark?.url || p.text || '';
        case 'link_mention':
          return p.link_mention?.url || p.text || '';
        case 'image':
        case 'attachment':
          return ''; // imported as files
        case 'table-embed':
          return tableToText(p['table-embed']);
        case 'emoticon':
          return p.emoticon?.code ? String.fromCodePoint(...p.emoticon.code.split('-').map((h) => parseInt(h, 16))) : p.text || '';
        case 'task_mention':
          return p.text || `#${p.task_mention?.task_id || ''}`;
        default: {
          const text = p.text || '';
          const link = p.attributes?.link;
          if (!link) return text;
          if (!text.trim()) return link;
          return link.includes(text.trim().replace(/^https?:\/\//, '')) ? link : `${text} (${link})`;
        }
      }
    })
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Plain-text description from ClickUp markdown (the app shows descriptions as plain text).
 * text_content loses link targets, so links become full URLs and images point at the attachments.
 */
function markdownToText(markdown, fallback) {
  const md = String(markdown || '').replace(/\r\n/g, '\n');
  if (!md.trim()) return String(fallback || '').trim();
  return md
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => `[Image: ${alt || decodeURIComponent(url.split('/').pop() || 'image')} — see attachments]`)
    .replace(/\[([\s\S]*?)\]\((\S+?)\)/g, (_, text, url) => {
      const label = text.replace(/\s+/g, ' ').trim();
      if (url.startsWith('#')) return label; // in-app anchors such as [@Name](#user_mention#123)
      const bare = (s) => s.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!label || label.split(' ').every((w) => bare(url).includes(bare(w)) || bare(w).includes(bare(url)))) return url;
      return `${label} (${url})`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ClickUp custom field value as display text, or null when empty. */
function customFieldText(field) {
  const v = field.value;
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  const options = field.type_config?.options || [];
  switch (field.type) {
    case 'drop_down': {
      const o = options.find((x) => String(x.id) === String(v) || String(x.orderindex) === String(v));
      return o?.name || String(v);
    }
    case 'labels':
      return (Array.isArray(v) ? v : [v]).map((id) => options.find((x) => String(x.id) === String(id))?.label || id).join(', ');
    case 'manual_progress':
    case 'automatic_progress':
      return `${v.percent_completed ?? 0}%`;
    case 'checkbox':
      return String(v) === 'true' ? 'Yes' : 'No';
    case 'date':
      return new Date(Number(v)).toISOString().slice(0, 10);
    case 'users':
      return (Array.isArray(v) ? v : [v]).map((u) => u.username || u.email || u.id).join(', ');
    case 'tasks':
      return (Array.isArray(v) ? v : [v]).map((t) => t.name || t.id).join(', ');
    case 'location':
      return v.formatted_address || JSON.stringify(v);
    case 'currency':
    case 'number':
    case 'emoji':
    case 'rating':
      return String(v);
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function taskDescription(task) {
  const body = markdownToText(task.markdown_description, task.text_content);
  const extras = (task.custom_fields || [])
    .map((f) => [f.name, customFieldText(f)])
    .filter(([, text]) => text != null)
    .map(([name, text]) => `${name}: ${text}`);
  if (task.points != null) extras.push(`Sprint points: ${task.points}`);
  if (!extras.length) return body;
  return `${body}${body ? '\n\n' : ''}— ClickUp fields —\n${extras.join('\n')}`;
}

/* ------------------------------------------------------------- uploads ---- */

let cloudinary = null;
const INLINE_TYPES = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'pdf', 'mp4', 'mov', 'webm', 'avi', 'mkv', 'mp3', 'wav', 'm4a']);

async function uploadFile(dir, file, undo) {
  if (!file.localFile) return { error: 'not downloaded during export' };
  const abs = path.join(dir, file.localFile);
  if (!fs.existsSync(abs)) return { error: 'file missing from export folder' };

  let name = file.name || path.basename(abs).split('__').pop();
  try {
    name = decodeURIComponent(name); // some ClickUp titles arrive URL-encoded ("WhatsApp%20Image…")
  } catch {
    /* keep as is */
  }
  const ext = lower(path.extname(name).slice(1) || (String(file.extension || '').includes('/') ? '' : file.extension));
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'file';
  // Raw files (docs, sheets, zips) need the extension in the public id to download correctly.
  const publicId = `${Date.now()}-${base}${ext && !INLINE_TYPES.has(ext) ? `.${ext}` : ''}`;

  if (!cloudinary) cloudinary = require('../config/cloudinary').cloudinary;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await cloudinary.uploader.upload(abs, {
        folder: 'task-manager/attachments',
        resource_type: 'auto',
        public_id: publicId,
        timeout: 180000,
      });
      undo.uploads.push({ publicId: res.public_id, resourceType: res.resource_type });
      return { url: res.secure_url, publicId: res.public_id, fileName: clip(name, 255), fileType: file.mimetype || null };
    } catch (err) {
      const message = err?.message || err?.error?.message || String(err);
      if (attempt === 2 || /file size|too large|invalid/i.test(message)) return { error: message };
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  return { error: 'upload failed' };
}

/* ---------------------------------------------------------------- plan ---- */

async function buildPlan({ manifest, tasks }) {
  const workspaceMembers = new Map();
  for (const m of manifest.members || []) {
    if (m.user?.id != null && m.user.email) workspaceMembers.set(String(m.user.id), m.user);
  }

  // Everyone referenced anywhere, so history keeps real names.
  const people = new Map();
  const see = (u) => {
    if (!u || u.id == null || Number(u.id) <= 0 || !u.email) return;
    const id = String(u.id);
    if (!people.has(id)) {
      const member = workspaceMembers.get(id);
      people.set(id, {
        clickupId: id,
        email: lower(u.email),
        name: clip(u.username || member?.username || u.email.split('@')[0], 100),
        avatarUrl: u.profilePicture || member?.profilePicture || null,
        clickupRole: member ? CLICKUP_ROLE[member.role] || 'member' : 'former',
      });
    }
  };
  for (const m of workspaceMembers.values()) see(m);
  for (const { task, comments } of tasks) {
    (Array.isArray(task.creator) ? task.creator : [task.creator]).forEach(see);
    (task.assignees || []).forEach(see);
    (task.watchers || []).forEach(see);
    (task.attachments || []).forEach((a) => see(a.user));
    for (const c of comments) {
      see(c.user);
      (c.replies || []).forEach((r) => see(r.user));
      for (const part of [...(c.comment || []), ...(c.replies || []).flatMap((r) => r.comment || [])]) {
        if (part.type === 'tag') see(part.user);
      }
    }
  }

  // Match against BIWORKSPACE accounts by email (plus explicit aliases).
  const aliases = new Map(
    opts('--alias').map((pair) => {
      const [from, to] = pair.split('=');
      return [lower(from), lower(to)];
    })
  );
  const emails = [...new Set([...people.values()].map((p) => aliases.get(p.email) || p.email))];
  const existingUsers = await User.find({ email: { $in: emails } })
    .select('_id name email role department isActive invitePending')
    .lean();
  const byEmail = new Map(existingUsers.map((u) => [lower(u.email), u]));
  for (const p of people.values()) {
    p.existing = byEmail.get(aliases.get(p.email) || p.email) || null;
    p.userId = p.existing?._id || null;
  }

  // Lists with at least one task become projects.
  const tasksByList = new Map();
  for (const entry of tasks) {
    const listId = String(entry.task.list?.id);
    if (!tasksByList.has(listId)) tasksByList.set(listId, []);
    tasksByList.get(listId).push(entry);
  }
  const spacesById = new Map(manifest.spaces.map((s) => [String(s.id), s]));
  const lists = manifest.lists.filter((l) => tasksByList.has(String(l.id)));
  const emptyLists = manifest.lists.filter((l) => !tasksByList.has(String(l.id)));

  const nameCounts = new Map();
  const projectName = (list) => {
    const space = spacesById.get(String(list.spaceId || list.space?.id));
    return /^list$/i.test(list.name.trim()) && space ? space.name : list.name.trim();
  };
  for (const l of lists) nameCounts.set(lower(projectName(l)), (nameCounts.get(lower(projectName(l))) || 0) + 1);

  const projects = lists.map((list) => {
    const space = spacesById.get(String(list.spaceId || list.space?.id));
    let name = projectName(list);
    if (nameCounts.get(lower(name)) > 1 && space) name = `${name} (${space.name})`;
    return { list, space, name: clip(name.replace(/\s+/g, ' '), 150), entries: tasksByList.get(String(list.id)) };
  });
  const spaces = [...new Set(projects.map((p) => p.space))].filter(Boolean);

  return { people, projects, spaces, emptyLists, workspaceMembers };
}

/* --------------------------------------------------------------- apply ---- */

function projectStatuses(list, entries) {
  const clickupStatuses = [...(list.statuses || [])];
  for (const { task } of entries) {
    if (task.status && !clickupStatuses.some((s) => lower(s.status) === lower(task.status.status))) {
      clickupStatuses.push(task.status);
    }
  }
  clickupStatuses.sort((a, b) => Number(a.orderindex ?? 99) - Number(b.orderindex ?? 99));

  const byKey = new Map();
  for (const s of clickupStatuses) {
    const key = mapStatus(s);
    if (!byKey.has(key)) byKey.set(key, { key, label: clip(String(s.status).toUpperCase(), 40), color: s.color || DEFAULT_STATUS_COLOR[key] });
  }
  for (const key of [TASK_STATUS.TODO, TASK_STATUS.IN_PROGRESS, TASK_STATUS.DONE]) {
    if (!byKey.has(key)) {
      const starter = getWorkflowTemplate('starter').statuses.find((s) => s.key === key);
      byKey.set(key, { ...starter });
    }
  }
  return STATUS_ORDER.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
}

function flattenChecklists(task, reporter, createdAt) {
  const items = [];
  const lists = task.checklists || [];
  for (const checklist of [...lists].sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0))) {
    const prefix = lists.length > 1 || !/^checklist$/i.test(String(checklist.name || '').trim())
      ? `${String(checklist.name || 'Checklist').trim()}: `
      : '';
    const walk = (nodes, depth) => {
      for (const item of [...(nodes || [])].sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0))) {
        if (!item || typeof item !== 'object') continue;
        const text = clip(`${prefix}${depth ? '– '.repeat(depth) : ''}${item.name || ''}`, 500);
        if (text) {
          const itemCreated = toDate(item.date_created) || createdAt;
          items.push({
            _id: oid(),
            text,
            isDone: Boolean(item.resolved),
            doneAt: item.resolved ? toDate(task.date_closed) || toDate(task.date_updated) || itemCreated : null,
            createdBy: reporter,
            createdAt: itemCreated,
            updatedAt: itemCreated,
          });
        }
        walk(item.children, depth + 1);
      }
    };
    walk(checklist.items, 0);
  }
  return items;
}

async function run() {
  const dir = path.resolve(opt('--dir') || '');
  if (!opt('--dir') || !fs.existsSync(path.join(dir, 'manifest.json'))) {
    console.error('Pass --dir <export folder containing manifest.json>');
    process.exit(1);
  }
  const data = loadExport(dir);
  const { manifest, tasks, missing } = data;

  await mongoose.connect(process.env.MONGO_URI, { dbName: opt('--db'), autoIndex: false });
  const dbName = mongoose.connection.db.databaseName;
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} · database "${dbName}" · export of "${manifest.workspace.name}" from ${manifest.exportedAt}`);
  if (missing.length) console.log(`! ${count(missing.length, 'task')} listed in the manifest have no saved file (export failures) and will be skipped`);

  const actorEmail = opt('--actor');
  const actor = actorEmail
    ? await User.findOne({ email: lower(actorEmail), isActive: true }).lean()
    : await User.findOne({ role: ROLES.SUPERADMIN, isActive: true, invitePending: { $ne: true } }).sort({ createdAt: 1 }).lean();
  if (!actor || actor.role !== ROLES.SUPERADMIN) {
    throw new Error('Import actor must be an active superadmin (use --actor <email>).');
  }
  const plan = await buildPlan(data);
  const { people, projects, spaces, emptyLists } = plan;

  // Team lead: --lead, else the ClickUp workspace owner's BIWORKSPACE account, else the actor.
  const leadEmail = opt('--lead');
  const owner = [...people.values()].find((p) => p.clickupRole === 'owner' && p.existing?.isActive && !p.existing?.invitePending);
  const lead = leadEmail
    ? await User.findOne({ email: lower(leadEmail), isActive: true }).lean()
    : owner
      ? await User.findById(owner.userId).lean()
      : actor;
  if (!lead) throw new Error(`--lead ${leadEmail} not found`);

  // Team rosters (by ClickUp id): everyone who created, was assigned or commented in the space.
  // Members with no activity anywhere join the busiest space's team, so everyone has a team.
  const isActiveMember = (p) => p && p.clickupRole !== 'former' && p.clickupRole !== 'guest';
  const creatorsOf = (task) => (Array.isArray(task.creator) ? task.creator : [task.creator]);
  const rosters = new Map();
  for (const space of spaces) {
    const ids = new Set();
    for (const p of projects.filter((x) => x.space === space)) {
      for (const { task, comments } of p.entries) {
        [...creatorsOf(task), ...(task.assignees || []), ...comments.flatMap((c) => [c.user, ...(c.replies || []).map((r) => r.user)])]
          .map((u) => people.get(String(u?.id)))
          .filter(isActiveMember)
          .forEach((person) => ids.add(person.clickupId));
      }
    }
    if (space.private && Array.isArray(space.members)) {
      for (const m of space.members) {
        const person = people.get(String(m.user?.id));
        if (isActiveMember(person)) ids.add(person.clickupId);
      }
    }
    rosters.set(space, ids);
  }
  const taskCount = (space) => projects.filter((p) => p.space === space).reduce((n, p) => n + p.entries.length, 0);
  const busiest = [...spaces].sort((a, b) => taskCount(b) - taskCount(a))[0];
  const rostered = new Set([...rosters.values()].flatMap((ids) => [...ids]));
  const unrostered = [...people.values()].filter((p) => isActiveMember(p) && !rostered.has(p.clickupId));
  unrostered.forEach((p) => rosters.get(busiest)?.add(p.clickupId));

  const departmentName = clip(opt('--department') || manifest.workspace.name.replace(/'s Workspace$/i, ''), 100);
  let department = await Department.findOne({
    name: { $regex: `^${departmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
  }).lean();
  if (department && department.isActive === false) {
    throw new Error(`Department "${department.name}" exists but is deleted — pass --department with another name.`);
  }
  if (!department) {
    const codeClash = await Department.findOne({ code: slug(departmentName) }).lean();
    if (codeClash) throw new Error(`Department code "${slug(departmentName)}" is taken by "${codeClash.name}" — pass --department.`);
  }

  /* --- report the plan --- */
  const peopleList = [...people.values()];
  const newActive = peopleList.filter((p) => !p.userId && p.clickupRole !== 'former' && p.clickupRole !== 'guest');
  const newGuests = peopleList.filter((p) => !p.userId && p.clickupRole === 'guest');
  const newFormer = peopleList.filter((p) => !p.userId && p.clickupRole === 'former');
  const matched = peopleList.filter((p) => p.userId);
  const commentTotal = tasks.reduce((n, t) => n + t.comments.reduce((k, c) => k + 1 + (c.replies || []).length, 0), 0);

  console.log(`\nDepartment: "${department?.name || departmentName}"${department ? ' (existing)' : ' (new)'}`);
  console.log(`Teams (one per space, lead ${lead.name}): ${spaces.map((s) => `${s.name} (${rosters.get(s).size} people)`).join(', ')}`);
  if (unrostered.length) console.log(`  ${count(unrostered.length, 'member')} with no ClickUp activity join "${busiest.name}": ${unrostered.map((p) => p.name).join(', ')}`);
  console.log(`Projects: ${projects.length} (lists with no tasks skipped: ${emptyLists.length})`);
  for (const p of projects) {
    console.log(`  - ${p.space?.name} › ${p.name}: ${count(p.entries.length, 'task')}${p.list.archived ? ' [archived list]' : ''}`);
  }
  console.log(`Tasks: ${tasks.length} · comments incl. replies: ${commentTotal}`);
  console.log(`People: ${matched.length} matched to existing accounts, ${newActive.length} new invites, ${newGuests.length} ClickUp guests, ${newFormer.length} former members (deactivated)`);
  for (const p of matched) console.log(`  = ${p.name} <${p.email}> → ${p.existing.name} (${p.existing.role}${p.existing.isActive ? '' : ', inactive'})`);
  for (const p of newActive) console.log(`  + ${p.name} <${p.email}> ClickUp ${p.clickupRole} → ${['owner', 'admin'].includes(p.clickupRole) ? 'ADMIN' : 'MEMBER'}, pending Google invite`);
  for (const p of newGuests) console.log(`  + ${p.name} <${p.email}> ClickUp guest → MEMBER on their projects only, pending Google invite`);
  for (const p of newFormer) console.log(`  ~ ${p.name} <${p.email}> not in ClickUp anymore → deactivated account (keeps history)`);

  // Same person under a different email? Flag name overlaps with accounts that did not match.
  const matchedIds = new Set(matched.map((p) => String(p.userId)));
  const others = await User.find({ _id: { $nin: [...matchedIds] }, email: { $not: /^deleted_/i } }).select('name email role invitePending').lean();
  const tokens = (name) => lower(name).split(/[^a-z]+/).filter((t) => t.length >= 4 && !['muhammad', 'syed', 'syeda', 'khan', 'malik'].includes(t));
  for (const p of [...newActive, ...newGuests, ...newFormer]) {
    const hits = others.filter((u) => tokens(u.name).some((t) => tokens(p.name).includes(t)));
    for (const u of hits) console.log(`  ? ${p.name} <${p.email}> may be the existing "${u.name}" <${u.email}>${u.invitePending ? ' (pending)' : ''} — use --alias ${p.email}=${u.email} if so`);
  }

  const maxAssignees = Math.max(0, ...tasks.map((t) => (t.task.assignees || []).length));
  const longTitles = tasks.filter((t) => t.task.name.length > 300).length;
  const longDescriptions = tasks.filter((t) => taskDescription(t.task).length > 20000).length;
  const fileCount = new Set(
    tasks.flatMap((t) => [
      ...(t.task.attachments || []).map((a) => String(a.id)),
      ...t.comments.flatMap((c) => [c, ...(c.replies || [])]).flatMap(commentFileParts).map((x) => String(x.id)),
    ])
  ).size;
  console.log(`Max assignees on one task: ${maxAssignees} · titles clipped: ${longTitles} · descriptions clipped: ${longDescriptions} · files: ${fileCount}${WITH_FILES ? '' : ' (skipped: --no-files)'}`);

  if (!APPLY) {
    console.log('\nDry run only — nothing written. Re-run with --apply to import.');
    return;
  }

  /* --- apply --- */
  const undoFile = path.resolve('backups', `clickup-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const undo = {
    db: dbName,
    startedAt: new Date().toISOString(),
    exportDir: dir,
    created: { departments: [], teams: [], users: [], projects: [], tasks: [], comments: [] },
    updated: { users: [], teams: [] },
    uploads: [],
    fileErrors: [],
  };
  const saveUndo = () => writeJson(undoFile, undo);
  saveUndo();
  console.log(`\nUndo record: ${undoFile}`);

  await Promise.all([Project, Task, Comment].map((m) => m.createIndexes()));

  if (!department) {
    const created = await Department.create({
      name: departmentName,
      code: slug(departmentName),
      description: 'Imported from ClickUp',
    });
    department = created.toObject();
    undo.created.departments.push(String(department._id));
    saveUndo();
  }

  // People
  const now = new Date();
  for (const p of peopleList) {
    if (p.userId) {
      const u = p.existing;
      const deptActive = u.department ? await Department.exists({ _id: u.department, isActive: true }) : null;
      if (p.clickupRole !== 'former' && u.role !== ROLES.SUPERADMIN && !deptActive) {
        undo.updated.users.push({ id: String(u._id), department: u.department ? String(u.department) : null });
        await User.updateOne({ _id: u._id }, { $set: { department: department._id } });
      }
      continue;
    }
    const isFormer = p.clickupRole === 'former';
    const user = await User.create({
      name: p.name,
      email: p.email,
      authProvider: 'google',
      role: ['owner', 'admin'].includes(p.clickupRole) ? ROLES.ADMIN : ROLES.MEMBER,
      department: department._id,
      avatarUrl: p.avatarUrl,
      invitePending: !isFormer,
      invitedBy: actor._id,
      isActive: !isFormer,
      deactivatedAt: isFormer ? now : null,
    });
    p.userId = user._id;
    undo.created.users.push(String(user._id));
  }
  saveUndo();
  const userOf = (u) => (u && u.id != null ? people.get(String(u.id))?.userId || null : null);

  // Teams — one per space
  const teamBySpace = new Map();
  for (const space of spaces) {
    const memberIds = [...rosters.get(space)]
      .map((cid) => String(people.get(cid).userId))
      .filter((id) => id !== String(lead._id));

    let team = await Team.findOne({ name: clip(space.name, 100), department: department._id, isActive: true });
    if (team) {
      undo.updated.teams.push({ id: String(team._id), members: team.members.map(String) });
      team.members = [...new Set([...team.members.map(String), ...memberIds])];
      await team.save();
    } else {
      team = await Team.create({
        name: clip(space.name, 100),
        description: 'Imported from ClickUp',
        department: department._id,
        lead: lead._id,
        members: memberIds,
      });
      undo.created.teams.push(String(team._id));
    }
    teamBySpace.set(space, team);
    saveUndo();
  }

  // Projects
  const usedKeys = new Set((await Project.find().select('key').lean()).map((p) => p.key));
  const uniqueKey = (name) => {
    const base = generateProjectKey(name).slice(0, 8);
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base.slice(0, 10 - String(n).length)}${n}`;
    usedKeys.add(key);
    return key;
  };

  const template = getWorkflowTemplate('starter');
  for (const p of projects) {
    const team = teamBySpace.get(p.space);
    const involved = new Set();
    for (const { task } of p.entries) {
      [...(Array.isArray(task.creator) ? task.creator : [task.creator]), ...(task.assignees || [])]
        .map((u) => people.get(String(u?.id)))
        .filter((person) => person && person.clickupRole !== 'former')
        .forEach((person) => involved.add(String(person.userId)));
    }
    const members = [...new Set([String(team.lead), ...team.members.map(String), String(actor._id), ...involved])];

    let project = await Project.findOne({ 'external.source': SOURCE, 'external.id': String(p.list.id) });
    if (project) {
      p.doc = project;
      continue;
    }
    const created = p.entries.map((e) => toDate(e.task.date_created)).filter(Boolean);
    const updated = p.entries.map((e) => toDate(e.task.date_updated)).filter(Boolean);
    const developer = people.get(String(p.list.assignee?.id));
    project = new Project({
      name: p.name,
      key: uniqueKey(p.name),
      description: clip(p.list.content || '', 2000),
      team: team._id,
      owner: actor._id,
      developer: developer && developer.clickupRole !== 'former' ? developer.userId : null,
      members,
      status: p.list.archived ? 'archived' : 'active',
      startDate: toDate(p.list.start_date) || undefined,
      endDate: toDate(p.list.due_date) || undefined,
      icon: p.name[0]?.toUpperCase() || 'P',
      color: p.space?.color || '#292524',
      isPrivate: Boolean(p.space?.private),
      workflowTemplate: template.id,
      kind: 'project',
      statuses: projectStatuses(p.list, p.entries),
      defaultViews: [...template.defaultViews],
      clickApps: [...template.clickApps],
      activeView: 'list',
      taskSequence: 0,
      external: { source: SOURCE, id: String(p.list.id) },
    });
    project.createdAt = created.length ? new Date(Math.min(...created)) : now;
    project.updatedAt = updated.length ? new Date(Math.max(...updated)) : now;
    await project.save({ timestamps: false });
    p.doc = project;
    undo.created.projects.push(String(project._id));
    saveUndo();
  }
  console.log(`Projects ready: ${projects.length}`);

  // Tasks — ids first, so parents and dependencies can point at each other.
  const taskIdByClickup = new Map();
  const existingTasks = await Task.find({ 'external.source': SOURCE }).select('_id external.id').lean();
  for (const t of existingTasks) taskIdByClickup.set(t.external.id, t._id);
  const toCreate = tasks.filter(({ task }) => !taskIdByClickup.has(String(task.id)));
  for (const { task } of toCreate) taskIdByClickup.set(String(task.id), oid());

  const blockedBy = new Map();
  const related = new Map();
  const addTo = (map, from, to) => {
    const a = taskIdByClickup.get(String(from));
    const b = taskIdByClickup.get(String(to));
    if (!a || !b || String(a) === String(b)) return;
    if (!map.has(String(a))) map.set(String(a), new Set());
    map.get(String(a)).add(String(b));
  };
  for (const { task } of tasks) {
    for (const d of task.dependencies || []) addTo(blockedBy, d.task_id, d.depends_on);
    for (const l of task.linked_tasks || []) {
      addTo(related, l.task_id, l.link_id);
      addTo(related, l.link_id, l.task_id);
    }
  }

  const createIds = new Set(toCreate.map(({ task }) => String(task.id)));
  let taskDone = 0;
  let clippedAssignees = 0;
  for (const p of projects) {
    const project = p.doc;
    const fresh = p.entries
      .filter(({ task }) => createIds.has(String(task.id)))
      .sort((a, b) => Number(a.task.date_created) - Number(b.task.date_created));
    if (!fresh.length) continue;

    // Board order: ClickUp orderindex within each status column, after existing cards.
    const positions = new Map();
    const byStatus = new Map();
    for (const e of fresh) {
      const key = mapStatus(e.task.status);
      if (!byStatus.has(key)) byStatus.set(key, []);
      byStatus.get(key).push(e);
    }
    for (const [status, list] of byStatus) {
      const last = await Task.findOne({ project: project._id, status }).sort({ position: -1 }).select('position').lean();
      list
        .sort((a, b) => Number(a.task.orderindex) - Number(b.task.orderindex))
        .forEach((e, i) => positions.set(e.task.id, (last?.position ?? -1) + 1 + i));
    }

    let sequence = project.taskSequence || 0;
    for (const { task, comments } of fresh) {
      sequence += 1;
      const _id = taskIdByClickup.get(String(task.id));
      const creator = Array.isArray(task.creator) ? task.creator[0] : task.creator;
      const reporter = userOf(creator) || actor._id;
      const createdAt = toDate(task.date_created) || now;
      const status = mapStatus(task.status);
      const assignees = [...new Set((task.assignees || []).map(userOf).filter(Boolean).map(String))];
      if (assignees.length > 3) clippedAssignees++;

      const attachments = [];
      const commentFileIds = new Set(
        comments
          .flatMap((c) => [c, ...(c.replies || [])])
          .flatMap(commentFileParts)
          .map((f) => String(f.id))
      );
      if (WITH_FILES) {
        for (const a of task.attachments || []) {
          if (a.deleted || a.is_folder || commentFileIds.has(String(a.id))) continue;
          const uploaded = await uploadFile(dir, { id: a.id, name: a.title, localFile: a.localFile, mimetype: a.mimetype, extension: a.extension }, undo);
          if (uploaded.error) {
            undo.fileErrors.push({ task: task.id, file: a.title, error: uploaded.error });
            continue;
          }
          attachments.push({ ...uploaded, uploadedBy: userOf(a.user) || reporter, uploadedAt: toDate(a.date) || createdAt });
        }
      }

      const doc = new Task({
        _id,
        key: `${project.key}-${sequence}`,
        title: clip(task.name, 300) || 'Untitled task',
        description: clip(taskDescription(task), 20000),
        project: project._id,
        parentTask: task.parent ? taskIdByClickup.get(String(task.parent)) || null : null,
        status,
        priority: mapPriority(task.priority),
        assignees,
        reporter,
        startDate: toDate(task.start_date),
        dueDate: toDate(task.due_date) || undefined,
        completedAt: status === TASK_STATUS.DONE ? toDate(task.date_done) || toDate(task.date_closed) || toDate(task.date_updated) : null,
        labels: [...new Set((task.tags || []).map((t) => clip(t.name, 40)).filter(Boolean))],
        attachments,
        checklist: flattenChecklists(task, reporter, createdAt),
        blockedBy: [...(blockedBy.get(String(_id)) || [])],
        relatedTasks: [...(related.get(String(_id)) || [])],
        estimateHours: toHours(task.time_estimate),
        loggedHours: toHours(task.time_spent),
        position: positions.get(task.id) ?? 0,
        isArchived: Boolean(task.archived),
        approvalStatus: Task.APPROVAL_STATUS.APPROVED,
        approvedBy: actor._id,
        approvedAt: createdAt,
        external: { source: SOURCE, id: String(task.id) },
      });
      doc.createdAt = createdAt;
      doc.updatedAt = toDate(task.date_updated) || createdAt;
      await doc.save({ timestamps: false });
      undo.created.tasks.push(String(_id));

      taskDone++;
      if (taskDone % 50 === 0) {
        saveUndo();
        console.log(`  tasks ${taskDone}/${toCreate.length}`);
      }
    }
    await Project.updateOne({ _id: project._id }, { $set: { taskSequence: sequence } });
  }
  saveUndo();
  console.log(`Tasks created: ${taskDone} (skipped existing: ${tasks.length - toCreate.length})`);

  // Comments + replies (replies follow their thread, marked as replies).
  const existingComments = new Set(
    (await Comment.find({ 'external.source': SOURCE }).select('external.id').lean()).map((c) => c.external.id)
  );
  let commentsDone = 0;
  for (const { task, comments } of tasks) {
    const taskId = taskIdByClickup.get(String(task.id));
    const rows = [];
    for (const c of [...comments].sort((a, b) => Number(a.date) - Number(b.date))) {
      rows.push({ c, replyTo: null });
      for (const r of [...(c.replies || [])].sort((a, b) => Number(a.date) - Number(b.date))) rows.push({ c: r, replyTo: c });
    }
    for (const { c, replyTo } of rows) {
      if (existingComments.has(String(c.id))) continue;
      const authorPerson = people.get(String(c.user?.id));
      const author = authorPerson?.userId || actor._id;
      let content = commentToText(c);
      if (!authorPerson?.userId && c.user?.username) content = `${c.user.username}: ${content}`;
      if (replyTo) content = `↳ Reply to ${replyTo.user?.username || 'comment'}: ${content}`;

      const attachments = [];
      if (WITH_FILES) {
        for (const f of commentFileParts(c)) {
          const uploaded = await uploadFile(dir, f, undo);
          if (uploaded.error) {
            undo.fileErrors.push({ task: task.id, comment: c.id, file: f.name, error: uploaded.error });
            continue;
          }
          attachments.push({ ...uploaded, uploadedBy: author, uploadedAt: toDate(c.date) || now });
        }
      }
      if (!content && !attachments.length) continue;

      const mentions = [...new Set((c.comment || []).filter((part) => part.type === 'tag').map((part) => userOf(part.user)).filter(Boolean).map(String))];
      const doc = new Comment({
        task: taskId,
        author,
        content: clip(content, 10000),
        mentions,
        attachments,
        external: { source: SOURCE, id: String(c.id) },
      });
      doc.createdAt = toDate(c.date) || now;
      doc.updatedAt = doc.createdAt;
      await doc.save({ timestamps: false });
      undo.created.comments.push(String(doc._id));
      commentsDone++;
      if (commentsDone % 100 === 0) {
        saveUndo();
        console.log(`  comments ${commentsDone}`);
      }
    }
  }
  undo.finishedAt = new Date().toISOString();
  saveUndo();

  console.log(`Comments created: ${commentsDone}`);
  console.log(`Files uploaded: ${undo.uploads.length} · failed: ${undo.fileErrors.length}`);
  if (clippedAssignees) console.log(`Tasks with more than 3 assignees: ${clippedAssignees}`);
  console.log(`\nImport finished. Undo with: node src/scripts/clickup-import.js --undo "${undoFile}" --apply`);
}

/* ---------------------------------------------------------------- undo ---- */

async function runUndo(file) {
  const undo = readJson(path.resolve(file));
  await mongoose.connect(process.env.MONGO_URI, { dbName: opt('--db') || undo.db, autoIndex: false });
  const dbName = mongoose.connection.db.databaseName;
  if (dbName !== undo.db) throw new Error(`Undo file is for "${undo.db}", connected to "${dbName}".`);

  const { created, updated } = undo;
  console.log(`${APPLY ? 'UNDO' : 'UNDO DRY RUN'} · database "${dbName}"`);
  console.log(`  delete ${created.comments.length} comments, ${created.tasks.length} tasks, ${created.projects.length} projects, ${created.teams.length} teams, ${created.users.length} users, ${created.departments.length} departments, ${undo.uploads.length} files`);
  console.log(`  restore ${updated.users.length} user departments, ${updated.teams.length} team rosters`);
  if (!APPLY) return;

  await Comment.deleteMany({ _id: { $in: created.comments } });
  await Task.deleteMany({ _id: { $in: created.tasks } });
  await Project.deleteMany({ _id: { $in: created.projects } });
  await Team.deleteMany({ _id: { $in: created.teams } });
  await User.deleteMany({ _id: { $in: created.users }, lastLoginAt: null });
  const signedIn = await User.find({ _id: { $in: created.users }, lastLoginAt: { $ne: null } }).select('name').lean();
  if (signedIn.length) console.log(`  kept ${signedIn.length} imported users who already signed in: ${signedIn.map((u) => u.name).join(', ')}`);
  for (const u of updated.users) await User.updateOne({ _id: u.id }, { $set: { department: u.department } });
  for (const t of updated.teams) await Team.updateOne({ _id: t.id }, { $set: { members: t.members } });
  await Department.deleteMany({ _id: { $in: created.departments } });

  if (undo.uploads.length) {
    const { cloudinary: cld } = require('../config/cloudinary');
    const byType = undo.uploads.reduce((m, u) => ((m[u.resourceType] ||= []).push(u.publicId), m), {});
    for (const [type, ids] of Object.entries(byType)) {
      for (let i = 0; i < ids.length; i += 100) {
        await cld.api.delete_resources(ids.slice(i, i + 100), { resource_type: type });
      }
    }
  }
  console.log('  done');
}

if (require.main === module) {
  (async () => {
    try {
      if (opt('--undo')) await runUndo(opt('--undo'));
      else await run();
    } catch (err) {
      console.error('IMPORT FAILED:', err.message);
      process.exitCode = 1;
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
  })();
}

module.exports = { mapStatus, mapPriority, markdownToText, commentToText, customFieldText, uploadFile };
