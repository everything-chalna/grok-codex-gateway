import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/jobs.mjs';
import { createJobStore } from '../src/store.mjs';
import { createJobWebhooks } from '../src/webhook.mjs';

const project = { id: 'example', name: 'Example', path: '/example', sources: ['AGENTS.md'] };
const targets = ['default', 'main', 'side2'];
const finished = ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
async function settled(service, id) {
  for (let n = 0; n < 200; n++) {
    const job = service.getStatus(id);
    if (finished.includes(job.state) && job.delivery?.status !== 'pending') return job;
    await delay(5);
  }
  assert.fail('Job did not settle');
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(5); }
  assert.fail('Fixture did not finish');
}
function setup(extra = {}) {
  return createService({ discover: async () => ({ projects: [project], warnings: [] }),
    codexWorker: async () => ({ text: 'Done', threadId: 'session' }),
    webhookTargets: targets, ...extra });
}
const tempDir = async (t, prefix) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('jobs record the owner from notify, owner alias or the default, and reject unknown names', async (t) => {
  const service = setup();
  t.after(() => service.close());
  const input = { project: project.id, prompt: 'Review' };
  assert.equal((await service.startCodex({ ...input, requestId: 'a', notify: 'main' })).owner, 'main');
  assert.equal((await service.startCodex({ ...input, requestId: 'b', owner: 'side2' })).owner, 'side2');
  assert.equal((await service.startCodex({ ...input, requestId: 'c', owner: 'side2', notify: 'side2' })).owner, 'side2');
  const implicit = await service.startCodex({ ...input, requestId: 'd' });
  assert.equal(implicit.owner, 'default');
  assert.equal(implicit.notify, 'default');
  await assert.rejects(service.startCodex({ ...input, requestId: 'e', notify: 'sub2' }), /Unknown notify target/);
  await assert.rejects(service.startCodex({ ...input, requestId: 'f', owner: 'sub2' }), /Unknown notify target/);
  await assert.rejects(service.startCodex({ ...input, requestId: 'g', owner: 'main', notify: 'side2' }), /same target/);
});

test('followups inherit the parent owner unless notify or owner is explicit', async (t) => {
  const service = setup();
  t.after(() => service.close());
  const parent = await service.startCodex({ project: project.id, prompt: 'Start', requestId: 'parent', notify: 'side2' });
  await settled(service, parent.jobId);
  const inherited = await service.followup({ jobId: parent.jobId, prompt: 'More', requestId: 'inherit' });
  assert.equal(inherited.owner, 'side2');
  assert.equal(inherited.parentJobId, parent.jobId);
  assert.equal((await service.followup({ jobId: parent.jobId, prompt: 'More', requestId: 'inherit' })).jobId, inherited.jobId);
  await settled(service, inherited.jobId);
  const overridden = await service.followup({ jobId: parent.jobId, prompt: 'Other', requestId: 'override', owner: 'main' });
  assert.equal(overridden.owner, 'main');
  await assert.rejects(service.followup({ jobId: parent.jobId, prompt: 'Bad', requestId: 'bad', notify: 'nobody' }), /Unknown notify target/);
});

test('jobs_pending and job_ack are isolated per owner', async (t) => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = setup({ codexWorker: async () => { if (++calls === 3) await blocked; return { text: 'Done' }; } });
  t.after(() => { release(); return service.close(); });
  const mine = await service.startCodex({ project: project.id, prompt: 'A', requestId: 'main-1', notify: 'main' });
  const theirs = await service.startCodex({ project: project.id, prompt: 'B', requestId: 'side-1', notify: 'side2' });
  await settled(service, mine.jobId);
  await settled(service, theirs.jobId);
  const active = await service.startCodex({ project: project.id, prompt: 'C', requestId: 'main-2', notify: 'main' });
  await until(() => service.getStatus(active.jobId).state === 'running');
  const pendingMain = service.listPending({ owner: 'main' });
  assert.deepEqual(pendingMain.jobs.map(job => job.jobId), [mine.jobId]);
  assert.equal(pendingMain.jobs[0].requestId, 'main-1');
  assert.equal(pendingMain.jobs[0].project, project.id);
  assert.equal(pendingMain.jobs[0].state, 'completed');
  assert.ok(pendingMain.jobs[0].finishedAt);
  assert.deepEqual(service.listPending({ owner: 'side2' }).jobs.map(job => job.jobId), [theirs.jobId]);
  assert.equal(service.listPending({ owner: 'default' }).count, 0);
  assert.throws(() => service.listPending({ owner: 'nobody' }), /owner must name/);
  assert.throws(() => service.listPending({}), /owner must name/);
  assert.throws(() => service.ack({ jobId: theirs.jobId, owner: 'main' }), /another owner/);
  assert.throws(() => service.ack({ jobId: active.jobId, owner: 'main' }), /Only a finished job/);
  assert.equal(service.ack({ jobId: mine.jobId, owner: 'main' }).acked, true);
  assert.equal(service.ack({ jobId: mine.jobId, owner: 'main' }).acked, true);
  assert.equal(service.listPending({ owner: 'main' }).count, 0);
  assert.equal(service.listPending({ owner: 'side2' }).count, 1);
  const listed = service.listJobs({ owner: 'main', limit: 10 });
  assert.deepEqual(listed.jobs.map(job => job.jobId), [active.jobId, mine.jobId]);
  assert.equal(service.listJobs({ owner: 'main', limit: 1 }).count, 1);
  assert.throws(() => service.listJobs({ owner: 'main', limit: 0 }), /limit/);
  release();
  await settled(service, active.jobId);
  assert.deepEqual(service.listPending({ owner: 'main' }).jobs.map(job => job.jobId), [active.jobId]);
});

test('job records persist across restarts; unfinished jobs become interrupted and pending', async (t) => {
  const dir = await tempDir(t, 'gateway-store-test-');
  const store = await createJobStore(dir, { log: () => {} });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let calls = 0;
  const first = setup({ store, codexWorker: async () => {
    if (++calls === 2) await blocked;
    return { text: 'PERSISTED_RESULT', threadId: '00000000-0000-4000-8000-000000000000' };
  } });
  const done = await first.startCodex({ project: project.id, prompt: 'PRIVATE_PROMPT', requestId: 'persist-1', notify: 'side2' });
  await settled(first, done.jobId);
  const acked = await first.startCodex({ project: project.id, prompt: 'PRIVATE_PROMPT', requestId: 'persist-2', notify: 'main' });
  const stuck = await first.startCodex({ project: project.id, prompt: 'PRIVATE_PROMPT', requestId: 'persist-3', notify: 'side2' });
  await until(() => first.getStatus(acked.jobId).state === 'running');
  await store.flush();
  // Simulate a crash: the first service never closes, so nothing is cancelled.
  const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 3);
  for (const name of files) {
    assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(dir, name), 'utf8'), /PRIVATE_PROMPT/);
  }
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const reloadedStore = await createJobStore(dir, { log: () => {} });
  assert.equal(reloadedStore.records.length, 3);
  const second = setup({ store: reloadedStore });
  t.after(() => second.close());
  const restored = second.getResult(done.jobId);
  assert.equal(restored.state, 'completed');
  assert.equal(restored.owner, 'side2');
  assert.equal(restored.result, 'PERSISTED_RESULT');
  assert.equal(restored.exitCode, 0);
  assert.equal(restored.delivery.status, 'unknown');
  for (const id of [acked.jobId, stuck.jobId]) {
    const job = second.getStatus(id);
    assert.equal(job.state, 'interrupted');
    assert.equal(job.delivery.status, 'skipped');
  }
  assert.deepEqual(second.listPending({ owner: 'side2' }).jobs.map(job => job.jobId).sort(), [done.jobId, stuck.jobId].sort());
  second.ack({ jobId: acked.jobId, owner: 'main' });
  // requestId deduplication survives the restart.
  assert.equal((await second.startCodex({ project: project.id, prompt: 'PRIVATE_PROMPT', requestId: 'persist-1', notify: 'side2' })).jobId, done.jobId);
  await assert.rejects(second.startCodex({ project: project.id, prompt: 'Other', requestId: 'persist-1' }), /different request/);
  // A restored session can be continued and keeps its owner.
  const next = await second.followup({ jobId: done.jobId, prompt: 'Continue', requestId: 'persist-4' });
  assert.equal(next.owner, 'side2');
  await settled(second, next.jobId);
  await second.close();
  const third = setup({ store: await createJobStore(dir, { log: () => {} }) });
  t.after(() => third.close());
  assert.equal(third.getStatus(acked.jobId).acked, true);
  assert.equal(third.listPending({ owner: 'main' }).count, 0);
  assert.equal(third.getStatus(next.jobId).parentJobId, done.jobId);
  assert.equal(third.listPending({ owner: 'side2' }).count, 3);
});

test('job store rejects the source checkout and skips unreadable records', async (t) => {
  await assert.rejects(createJobStore(new URL('../.tmp/jobs-test', import.meta.url).pathname, { log: () => {} }), /outside the source checkout/);
  const dir = await tempDir(t, 'gateway-store-bad-');
  await writeFile(join(dir, '00000000-0000-4000-8000-000000000001.json'), '{not json');
  await writeFile(join(dir, 'notes.json'), '{}');
  await writeFile(join(dir, '.leftover-1.tmp'), 'x');
  const logs = [];
  const store = await createJobStore(dir, { log: line => logs.push(line) });
  assert.equal(store.records.length, 0);
  assert.equal(store.skipped, 2);
  assert.deepEqual(logs, ['Job store: skipped 2 unreadable record(s)']);
  assert.deepEqual((await readdir(dir)).sort(), ['00000000-0000-4000-8000-000000000001.json', 'notes.json']);
});

test('completion webhooks go only to the owner target and record delivery status', async (t) => {
  const dir = await tempDir(t, 'gateway-owner-webhook-');
  const keyFile = join(dir, 'webhook.key');
  await writeFile(keyFile, 'EXAMPLE_NOT_A_SECRET\n');
  const hits = [];
  const statusFor = { '/default': 200, '/main': 204, '/side2': 200 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    hits.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(statusFor[req.url] ?? 404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const webhooks = Object.fromEntries(targets.map(name => [name, { url: `https://example.test/${name}`, keyFile }]));
  const options = { log: () => {}, wait: async () => {},
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init) };
  const run = async (fallbackToDefault, requestId) => {
    const service = setup({ onJobFinished: createJobWebhooks({ webhooks, defaultWebhook: 'default', fallbackToDefault }, options) });
    t.after(() => service.close());
    const job = await service.startCodex({ project: project.id, prompt: 'PRIVATE_PROMPT', requestId, notify: 'side2' });
    return settled(service, job.jobId);
  };
  const ok = await run(false, 'routed');
  assert.deepEqual(hits.map(hit => hit.path), ['/side2']);
  assert.equal(hits[0].body.owner, 'side2');
  assert.equal(hits[0].body.route, 'side2');
  assert.doesNotMatch(JSON.stringify(hits[0].body), /PRIVATE_PROMPT|EXAMPLE_NOT_A_SECRET|Done/);
  assert.equal(ok.delivery.status, 'delivered');
  assert.equal(ok.delivery.route, 'side2');
  assert.equal(ok.delivery.httpStatus, 200);

  hits.length = 0;
  statusFor['/side2'] = 503;
  const failed = await run(false, 'failing');
  assert.deepEqual(hits.map(hit => hit.path), ['/side2', '/side2']);
  assert.equal(failed.delivery.status, 'failed');
  assert.equal(failed.delivery.attempts, 2);
  assert.equal(failed.delivery.httpStatus, 503);

  hits.length = 0;
  const fallback = await run(true, 'fallback');
  assert.deepEqual(hits.map(hit => hit.path), ['/side2', '/side2', '/default']);
  assert.equal(hits[2].body.owner, 'side2');
  assert.equal(hits[2].body.route, 'default');
  assert.equal(fallback.delivery.status, 'delivered');
  assert.equal(fallback.delivery.route, 'default');
  assert.equal(fallback.delivery.fallbackFrom, 'side2');
  assert.equal(fallback.delivery.attempts, 3);
});
