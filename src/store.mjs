import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { configDirectory } from './config.mjs';

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function jobStoreDirectory(directory = configDirectory()) {
  return path.join(directory, 'state', 'jobs');
}

// Disk state is the source of truth for finished jobs; webhooks only reduce
// latency. One JSON file per job, written atomically (temporary file + rename)
// with owner-only permissions, outside the source checkout. Records hold an
// explicit allowlist of fields and never the prompt.
export async function createJobStore(directory = jobStoreDirectory(), {
  log = message => console.error(message),
} = {}) {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const inside = (root, target) => {
    const relative = path.relative(root, target);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  // Check before creating anything, then again after resolving symlinks.
  if (inside(path.resolve(source), path.resolve(directory))) throw new Error('Job state directory must be outside the source checkout.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  if (inside(await realpath(source), resolved)) throw new Error('Job state directory must be outside the source checkout.');
  const report = message => { try { log(`Job store: ${message}`); } catch { /* Logging is best effort. */ } };
  const records = [];
  let skipped = 0;
  for (const name of await readdir(resolved)) {
    if (name.startsWith('.') && name.endsWith('.tmp')) { await rm(path.join(resolved, name), { force: true }); continue; }
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    try {
      if (!JOB_ID.test(id)) throw new Error('Unexpected file name');
      const record = JSON.parse(await readFile(path.join(resolved, name), 'utf8'));
      if (!record || record.id !== id || typeof record.state !== 'string' || typeof record.owner !== 'string') throw new Error('Invalid record');
      records.push(record);
    } catch { skipped++; }
  }
  if (skipped) report(`skipped ${skipped} unreadable record(s)`);
  const chains = new Map();
  const enqueue = (id, operation) => {
    const next = (chains.get(id) ?? Promise.resolve()).then(operation).catch(() => report('write failed'));
    chains.set(id, next);
    void next.then(() => { if (chains.get(id) === next) chains.delete(id); });
    return next;
  };
  const file = id => path.join(resolved, `${id}.json`);
  return {
    directory: resolved,
    records,
    skipped,
    save(record) {
      if (!JOB_ID.test(record?.id ?? '')) return Promise.resolve();
      const body = `${JSON.stringify(record)}\n`;
      return enqueue(record.id, async () => {
        const temporary = path.join(resolved, `.${record.id}-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
          await rename(temporary, file(record.id));
        } finally { await rm(temporary, { force: true }); }
      });
    },
    remove(id) {
      if (!JOB_ID.test(id ?? '')) return Promise.resolve();
      return enqueue(id, () => rm(file(id), { force: true }));
    },
    async flush() {
      while (chains.size) await Promise.all([...chains.values()]);
    },
  };
}
