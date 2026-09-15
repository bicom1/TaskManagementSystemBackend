/**
 * Export a ClickUp workspace to a local folder (read-only — GET requests only).
 *
 * The folder is a complete offline copy: workspace members, spaces, folders, lists,
 * every task (open, closed, archived, subtasks) with its comments and replies,
 * attachment files, docs and time entries. `clickup-import.js` reads this folder,
 * so after an export the ClickUp API is no longer needed.
 *
 * Usage:
 *   CLICKUP_TOKEN=pk_... node src/scripts/clickup-export.js [--out backups/clickup/<name>] [--no-files]
 *
 * The token is read from the environment only and never written to disk.
 * Re-running into the same --out folder resumes: tasks whose date_updated has not
 * changed since they were saved are skipped. Use a fresh folder for the final export.
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.CLICKUP_TOKEN;
const V2 = 'https://api.clickup.com/api/v2';
const V3 = 'https://api.clickup.com/api/v3';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = path.resolve(
  option('--out') || path.join('backups', 'clickup', new Date().toISOString().slice(0, 10))
);
const WITH_FILES = !flag('--no-files');
const TASK_CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/* ---------------------------------------------------------------- HTTP ---- */

const stats = { calls: 0, waits: 0, files: 0, fileBytes: 0, fileErrors: [] };
let pausedUntil = 0;

async function api(url, base = V2) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);

    let res;
    try {
      res = await fetch(base + url, { headers: { Authorization: TOKEN } });
    } catch (err) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    stats.calls++;

    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    if (res.status === 429 || (!Number.isNaN(remaining) && remaining <= 3)) {
      const until = reset > Date.now() ? reset + 1000 : Date.now() + 30000;
      if (until > pausedUntil) {
        pausedUntil = until;
        stats.waits++;
      }
      if (res.status === 429) continue;
    }
    if (res.status >= 500) {
      await sleep(3000 * (attempt + 1));
      continue;
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(`${res.status} ${body.err || body.message || ''} — GET ${url}`);
      error.status = res.status;
      throw error;
    }
    return body;
  }
  throw new Error(`Gave up after retries — GET ${url}`);
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/* --------------------------------------------------------------- files ---- */

const safeName = (name) =>
  String(name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(-120);

/** Download once into files/; returns the path relative to OUT (or null on failure). */
async function saveFile(id, name, url) {
  if (!WITH_FILES || !url) return null;
  const rel = path.join('files', `${safeName(id)}__${safeName(name)}`);
  const abs = path.join(OUT, rel);
  if (fs.existsSync(abs)) return rel.replace(/\\/g, '/');

  for (const headers of [{}, { Authorization: TOKEN }]) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      stats.files++;
      stats.fileBytes += buf.length;
      return rel.replace(/\\/g, '/');
    } catch {
      /* try next */
    }
  }
  stats.fileErrors.push({ id, name });
  return null;
}

/* ---------------------------------------------------------------- main ---- */

async function fetchComments(taskId) {
  const all = [];
  let query = '';
  for (;;) {
    const { comments = [] } = await api(`/task/${taskId}/comment${query}`);
    const fresh = comments.filter((c) => !all.some((x) => x.id === c.id));
    all.push(...fresh);
    if (comments.length < 25 || !fresh.length) break;
    const oldest = comments[comments.length - 1];
    query = `?start=${oldest.date}&start_id=${oldest.id}`;
  }
  for (const comment of all) {
    if (comment.reply_count > 0) {
      const { comments: replies = [] } = await api(`/comment/${comment.id}/reply`);
      comment.replies = replies;
    }
  }
  return all;
}

/** Attachment and image parts inside a comment (or reply). */
function commentFiles(comment) {
  return (comment.comment || [])
    .map((part) => {
      if (part.type === 'attachment' && part.attachment) {
        return { holder: part.attachment, id: part.attachment.id, name: part.attachment.title, url: part.attachment.url };
      }
      if (part.type === 'image' && part.image) {
        return { holder: part.image, id: part.image.id, name: part.image.name || part.image.title, url: part.image.url };
      }
      return null;
    })
    .filter(Boolean);
}

async function exportTask(summary) {
  const file = path.join(OUT, 'tasks', `${summary.id}.json`);
  const cached = readJson(file);
  if (cached && cached.task?.date_updated === summary.date_updated) return 'cached';

  const task = await api(`/task/${summary.id}?include_markdown_description=true`);
  const comments = await fetchComments(summary.id);

  for (const attachment of task.attachments || []) {
    attachment.localFile = await saveFile(attachment.id, attachment.title, attachment.url);
  }
  for (const comment of comments) {
    for (const item of [comment, ...(comment.replies || [])]) {
      for (const f of commentFiles(item)) {
        f.holder.localFile = await saveFile(f.id || `${item.id}-${f.name}`, f.name, f.url);
      }
    }
  }

  // Tasks in archived lists are only reachable per list; keep the archived flag.
  writeJson(file, { task: { ...task, archived: task.archived ?? summary.archived }, comments });
  return 'saved';
}

async function listTasks(workspaceId, archivedListIds) {
  const byId = new Map();
  const collect = (tasks, archived) => {
    for (const t of tasks) if (!byId.has(t.id)) byId.set(t.id, { ...t, archived: t.archived || archived });
  };

  for (const archived of [false, true]) {
    for (let page = 0; ; page++) {
      const body = await api(
        `/team/${workspaceId}/task?page=${page}&include_closed=true&subtasks=true&archived=${archived}`
      );
      collect(body.tasks || [], archived);
      if (body.last_page === true || (body.tasks || []).length < 100) break;
    }
  }

  for (const listId of archivedListIds) {
    for (const archived of [false, true]) {
      for (let page = 0; ; page++) {
        const body = await api(
          `/list/${listId}/task?page=${page}&include_closed=true&subtasks=true&archived=${archived}`
        );
        collect(body.tasks || [], archived);
        if (body.last_page === true || (body.tasks || []).length < 100) break;
      }
    }
  }
  return [...byId.values()];
}

async function exportDocs(workspaceId) {
  const docs = [];
  let cursor = '';
  try {
    for (;;) {
      const body = await api(`/workspaces/${workspaceId}/docs?limit=100${cursor ? `&cursor=${cursor}` : ''}`, V3);
      docs.push(...(body.docs || []));
      if (!body.next_cursor) break;
      cursor = encodeURIComponent(body.next_cursor);
    }
  } catch (err) {
    return { error: err.message, docs: [] };
  }
  for (const doc of docs) {
    try {
      const pages = await api(
        `/workspaces/${workspaceId}/docs/${doc.id}/pages?max_page_depth=-1&content_format=text/md`,
        V3
      );
      writeJson(path.join(OUT, 'docs', `${doc.id}.json`), { doc, pages });
    } catch (err) {
      writeJson(path.join(OUT, 'docs', `${doc.id}.json`), { doc, error: err.message });
    }
  }
  return { docs: docs.map((d) => ({ id: d.id, name: d.name, deleted: d.deleted, parent: d.parent })) };
}

async function main() {
  if (!TOKEN) {
    console.error('Set CLICKUP_TOKEN in the environment.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const started = Date.now();

  const { user: tokenUser } = await api('/user');
  const { teams = [] } = await api('/team');
  if (teams.length !== 1) {
    console.log(`Token sees ${teams.length} workspaces: ${teams.map((t) => t.name).join(', ')}`);
  }

  for (const workspace of teams) {
    console.log(`Workspace "${workspace.name}" (${workspace.id}) → ${OUT}`);

    const spaces = [];
    const folders = [];
    const lists = [];
    for (const archived of [false, true]) {
      const { spaces: found = [] } = await api(`/team/${workspace.id}/space?archived=${archived}`);
      spaces.push(...found.map((s) => ({ ...s, archived })));
    }
    for (const space of spaces) {
      for (const archived of [false, true]) {
        const { folders: found = [] } = await api(`/space/${space.id}/folder?archived=${archived}`);
        for (const folder of found) {
          folders.push({ ...folder, archived: folder.archived || archived, spaceId: space.id });
          for (const list of folder.lists || []) {
            lists.push({ ...list, archived: list.archived || folder.archived || archived, spaceId: space.id, folderId: folder.id });
          }
        }
        const { lists: loose = [] } = await api(`/space/${space.id}/list?archived=${archived}`);
        for (const list of loose) lists.push({ ...list, archived: list.archived || archived, spaceId: space.id, folderId: null });
      }
    }
    // Folder listings can omit archived lists; the per-list detail fills description & statuses.
    for (const list of lists) {
      try {
        const detail = await api(`/list/${list.id}`);
        Object.assign(list, detail, { archived: list.archived || detail.archived });
      } catch (err) {
        list.detailError = err.message;
      }
      try {
        const { fields = [] } = await api(`/list/${list.id}/field`);
        list.customFields = fields;
      } catch {
        list.customFields = [];
      }
    }
    console.log(`  ${spaces.length} spaces · ${folders.length} folders · ${lists.length} lists`);

    const summaries = await listTasks(
      workspace.id,
      lists.filter((l) => l.archived).map((l) => l.id)
    );
    console.log(`  ${summaries.length} tasks found — fetching details, comments and files…`);

    let done = 0;
    let cached = 0;
    const failures = [];
    await pool(summaries, TASK_CONCURRENCY, async (summary) => {
      try {
        if ((await exportTask(summary)) === 'cached') cached++;
      } catch (err) {
        failures.push({ id: summary.id, name: summary.name, error: err.message });
      }
      done++;
      if (done % 50 === 0 || done === summaries.length) {
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        console.log(`  ${done}/${summaries.length} tasks (${cached} unchanged) · ${stats.calls} API calls · ${stats.files} files · ${mins} min`);
      }
    });

    let timeEntries = [];
    try {
      const assignees = (workspace.members || []).map((m) => m.user.id).join(',');
      const body = await api(
        `/team/${workspace.id}/time_entries?start_date=0&end_date=${Date.now()}&include_task_tags=true&include_location_names=true${assignees ? `&assignee=${assignees}` : ''}`
      );
      timeEntries = body.data || [];
    } catch (err) {
      timeEntries = { error: err.message };
    }

    const docs = await exportDocs(workspace.id);

    writeJson(path.join(OUT, 'manifest.json'), {
      source: 'clickup',
      exportedAt: new Date().toISOString(),
      exportedBy: { id: tokenUser.id, username: tokenUser.username },
      workspace: { id: workspace.id, name: workspace.name, color: workspace.color, avatar: workspace.avatar },
      members: workspace.members || [],
      spaces,
      folders,
      lists,
      taskIds: summaries.map((t) => t.id),
      failures,
      timeEntries,
      docs,
      stats: { ...stats, minutes: Number(((Date.now() - started) / 60000).toFixed(1)) },
    });

    console.log(`  time entries: ${Array.isArray(timeEntries) ? timeEntries.length : timeEntries.error}`);
    console.log(`  docs: ${docs.error ? docs.error : docs.docs.length}`);
    console.log(`  files: ${stats.files} (${(stats.fileBytes / 1048576).toFixed(1)} MB), failed downloads: ${stats.fileErrors.length}`);
    console.log(`  task failures: ${failures.length}`);
  }
  console.log(`Done in ${((Date.now() - started) / 60000).toFixed(1)} min · ${stats.calls} API calls`);
}

main().catch((err) => {
  console.error('EXPORT FAILED:', err.message);
  process.exit(1);
});
