import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createJobWebhook, createJobWebhooks } from '../src/webhook.mjs';
import { loadConfig } from '../src/config.mjs';
import { createService } from '../src/jobs.mjs';

const key = 'EXAMPLE_NOT_A_SECRET';
async function fixture(t, status = 200, listen = true) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-webhook-test-'));
  const keyFile = join(dir, 'webhook.key');
  await writeFile(keyFile, key + '\n');
  const requests = [], logs = [], waits = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(body), method: req.method });
    res.writeHead(status); res.end(key);
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  if (listen) await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const config = { url: 'https://example.test/finished', keyFile };
  const options = { fetchImpl: (_, init) => fetch(`http://127.0.0.1:${server.address().port}`, init),
    log: line => logs.push(line), wait: async ms => { waits.push(ms); } };
  return { config, options, requests, logs, waits };
}
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(5); }
  assert.fail('Fixture did not finish');
}
test('absent webhook, missing key and empty key never send', async (t) => {
  const f = await fixture(t, 200, false);
  await createJobWebhook(undefined, f.options)({});
  await createJobWebhook({ ...f.config, keyFile: f.config.keyFile + '.missing' }, f.options)({});
  await writeFile(f.config.keyFile, ' \n');
  await createJobWebhook(f.config, f.options)({});
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.logs, []);
});
test('terminal jobs POST only the allowed metadata once, without prompt, output, paths or key', async (t) => {
  const f = await fixture(t);
  const project = { id: 'example', name: 'Example', path: tmpdir() };
  const service = createService({ discover: async () => ({ projects: [project] }),
    codexWorker: async () => ({ text: 'PRIVATE_RESULT' }), onJobFinished: createJobWebhook(f.config, f.options) });
  t.after(() => service.close());
  const job = await service.startCodex({ project: project.id, prompt: 'PRIVATE_PROMPT', requestId: 'request-one' });
  await until(() => f.requests.length === 1);
  service.cancel(job.jobId);
  const { body, headers, method } = f.requests[0];
  assert.equal(method, 'POST');
  assert.equal(headers.authorization, `Bearer ${key}`);
  assert.equal(headers['content-type'], 'application/json');
  const status = service.getStatus(job.jobId);
  assert.deepEqual(body, { event: 'codex_job_finished', jobId: job.jobId, kind: 'codex', state: 'completed',
    owner: 'default', notify: 'default', route: 'default', requester: 'unknown', projectName: 'Example', requestId: 'request-one', createdAt: status.createdAt, finishedAt: status.finishedAt, error: null });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|EXAMPLE_NOT_A_SECRET|projectPath/);
  assert.equal(f.requests.length, 1);
});
test('5xx retries once after 5 seconds; 4xx does not retry; logs exclude response bodies', async (t) => {
  for (const code of [503, 400]) {
    const f = await fixture(t, code);
    await createJobWebhook({ ...f.config, headerName: 'X-Webhook-Key', headerValuePrefix: '' }, f.options)({ event: 'fixture' });
    assert.equal(f.requests.length, code === 503 ? 2 : 1);
    assert.deepEqual(f.waits, code === 503 ? [5000] : []);
    assert.equal(f.requests[0].headers['x-webhook-key'], key);
    assert.ok(f.logs.every(line => /^Webhook: HTTP \d{3}$/.test(line)));
  }
});
test('network errors retry once, timeout is bounded, and failed observers do not affect jobs', async (t) => {
  const f = await fixture(t, 200, false);
  let attempts = 0;
  await createJobWebhook(f.config, { ...f.options, timeoutMs: 5, fetchImpl: async (_, { signal }) => {
    attempts++;
    await delay(10);
    signal.throwIfAborted();
    throw new Error(key);
  } })({});
  assert.equal(attempts, 2);
  assert.deepEqual(f.waits, [5000]);
  assert.deepEqual(f.logs, ['Webhook: delivery failed', 'Webhook: delivery failed']);
  const service = createService({ discover: async () => ({ projects: [] }), openAIWorker: async () => ({ text: 'OK' }),
    onJobFinished: async () => { throw new Error(key); } });
  t.after(() => service.close());
  const job = await service.startOpenAI({ prompt: 'fixture', requestId: 'failure' });
  await until(() => service.getStatus(job.jobId).state === 'completed');
  assert.equal(service.getResult(job.jobId).result, 'OK');
});
test('failed, timed out and queued/running cancelled jobs notify once', async (t) => {
  for (const state of ['failed', 'timed_out', 'queued_cancel', 'running_cancel']) {
    const events = [];
    let started = false;
    const service = createService({ discover: async () => ({ projects: [] }), jobTimeoutMs: 30,
      openAIWorker: async (_, { signal }) => {
        started = true;
        if (state === 'failed') throw new Error(key);
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        return { text: 'fixture' };
      }, onJobFinished: event => events.push(event) });
    t.after(() => service.close());
    const job = await service.startOpenAI({ prompt: 'PRIVATE_PROMPT', requestId: state });
    if (state === 'queued_cancel') service.cancel(job.jobId);
    if (state === 'running_cancel') { await until(() => started); service.cancel(job.jobId); }
    await until(() => events.length > 0);
    service.cancel(job.jobId);
    assert.equal(events.length, 1);
    assert.equal(events[0].state, state.endsWith('_cancel') ? 'cancelled' : state);
    assert.equal(events[0].projectName, null);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_PROMPT|EXAMPLE_NOT_A_SECRET/);
  }
});

test('loaded legacy and named targets route starts and followups, including URL files', async (t) => {
  const f = await fixture(t, 200, false);
  const dir = await mkdtemp(join(tmpdir(), 'gateway-routing-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const urlFile = join(dir, 'main.webhook.url');
  await writeFile(urlFile, 'https://example.test/main\n');
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    webhook: f.config,
    webhooks: { main: { urlFile, keyFile: f.config.keyFile, headerName: 'X-Key', headerValuePrefix: '' } },
  }));
  const config = await loadConfig(dir);
  const deliveries = [];
  const sender = createJobWebhooks(config, { log: () => {}, fetchImpl: async (url, init) => {
    deliveries.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(null, { status: 204 });
  } });
  const project = { id: 'fixture', name: 'Fixture', path: tmpdir() };
  const service = createService({ discover: async () => ({ projects: [project] }),
    codexWorker: async () => ({ text: 'PRIVATE_RESULT', threadId: 'fixture-thread' }),
    webhookTargets: Object.keys(config.webhooks), defaultWebhook: config.defaultWebhook, onJobFinished: sender });
  t.after(() => service.close());
  const start = { project: project.id, prompt: 'PRIVATE_PROMPT', requestId: 'legacy' };
  await assert.rejects(service.startCodex({ ...start, notify: 'Not Valid' }), /notify\/owner must be/);
  const first = await service.startCodex(start);
  await until(() => deliveries.length === 1);
  assert.equal(deliveries[0].url, f.config.url);
  assert.equal(deliveries[0].body.notify, 'default');
  await assert.rejects(service.followup({ jobId: first.jobId, prompt: 'fixture', requestId: 'bad', notify: 'Not Valid' }), /notify\/owner must be/);
  const next = await service.followup({ jobId: first.jobId, prompt: 'fixture', requestId: 'next', notify: 'main' });
  await until(() => deliveries.length === 2);
  assert.equal(service.getStatus(next.jobId).notify, 'main');
  assert.equal(deliveries[1].url, 'https://example.test/main');
  assert.equal(deliveries[1].body.notify, 'main');
  assert.equal(deliveries[1].headers.get('X-Key'), key);
  await service.startCodex({ ...start, requestId: 'named', notify: 'main' });
  await until(() => deliveries.length === 3);
  assert.equal(deliveries[2].url, 'https://example.test/main');
  await assert.rejects(service.startCodex({ ...start, notify: 'main' }), /different request/);
  // A followup without notify inherits its parent's owner instead of defaultWebhook.
  await service.followup({ jobId: next.jobId, prompt: 'fixture', requestId: 'inherited' });
  await until(() => deliveries.length === 4);
  assert.equal(deliveries[3].body.owner, 'main');
  assert.equal(deliveries[3].url, 'https://example.test/main');
  const alternate = createService({ discover: async () => ({ projects: [project] }),
    codexWorker: async () => ({ text: 'fixture' }), webhookTargets: ['main'], defaultWebhook: 'main', onJobFinished: sender });
  t.after(() => alternate.close());
  await alternate.startCodex({ ...start, requestId: 'alternate' });
  await until(() => deliveries.length === 5);
  assert.equal(deliveries[4].url, 'https://example.test/main');
  assert.equal(deliveries[4].body.notify, 'main');
  assert.doesNotMatch(JSON.stringify(deliveries.map(d => d.body)), /PRIVATE_|EXAMPLE_NOT_A_SECRET|projectPath|urlFile|keyFile/);
});
