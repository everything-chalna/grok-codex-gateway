import { createHash, randomUUID } from 'node:crypto';

export class GatewayError extends Error {
  constructor(message) { super(message); this.name = 'GatewayError'; this.safe = true; }
}

const TERMINAL = ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
const TARGET_NAME = /^[a-z0-9_-]{1,32}$/;
const EXIT_CODES = { completed: 0, failed: 1, cancelled: 130, timed_out: 124, interrupted: 1 };
const DELIVERY_STATES = ['pending', 'delivered', 'failed', 'skipped', 'unknown'];

// Delivery results come from the webhook layer; keep only fixed, non-secret fields.
function normalizeDelivery(result, owner) {
  const value = result && typeof result === 'object' ? result : {};
  const delivery = {
    status: DELIVERY_STATES.includes(value.status) ? value.status : 'unknown',
    route: typeof value.route === 'string' && TARGET_NAME.test(value.route) ? value.route : owner,
    attempts: Number.isInteger(value.attempts) && value.attempts >= 0 && value.attempts < 100 ? value.attempts : 0,
    httpStatus: Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null,
    at: new Date().toISOString(),
  };
  if (typeof value.reason === 'string' && /^[a-z ]{1,60}$/.test(value.reason)) delivery.reason = value.reason;
  if (typeof value.fallbackFrom === 'string' && TARGET_NAME.test(value.fallbackFrom)) delivery.fallbackFrom = value.fallbackFrom;
  return delivery;
}

// Each job has an owner: the webhook target name of the bot that started it.
// Owner routing is delivery discipline between trusted bots that share one
// gateway token, not an authentication boundary. A request ID deduplicates
// retries for as long as its job is retained; it is not a credential.
export function createService({ discover, codexWorker, openAIWorker = null,
  proxyState = { enabled: true, persist: async () => {} },
  onJobFinished = () => {}, webhookTargets = [], defaultWebhook = 'default', store = null,
  maxJobs = 100, maxQueue = 10, jobTimeoutMs = 30 * 60_000 }) {
  const targets = new Set(webhookTargets);
  const knownOwner = name => typeof name === 'string' && TARGET_NAME.test(name) && (targets.has(name) || name === defaultWebhook);
  // `owner` is an alias of `notify`. A well-formed name without its own
  // configured target is not an error: the job is routed to defaultWebhook
  // (which forwards it) and the name is kept as the job's requester.
  // Returns { name, owner } or undefined when neither was supplied.
  const explicitOwner = ({ notify, owner } = {}) => {
    for (const name of [notify, owner]) {
      if (name !== undefined && (typeof name !== 'string' || !TARGET_NAME.test(name))) {
        throw new GatewayError('notify/owner must be 1-32 lowercase letters, digits, underscores or hyphens.');
      }
    }
    if (notify !== undefined && owner !== undefined && notify !== owner) {
      throw new GatewayError('notify and owner must name the same target when both are supplied.');
    }
    const name = notify ?? owner;
    if (name === undefined) return undefined;
    return { name, owner: knownOwner(name) ? name : defaultWebhook };
  };
  // requester: free label of the bot that started the job (need not be a
  // configured target). Used for forwarding and audit, never for routing.
  const explicitRequester = (requester) => {
    if (requester === undefined) return undefined;
    if (typeof requester !== 'string' || !TARGET_NAME.test(requester)) {
      throw new GatewayError('requester must be 1-32 lowercase letters, digits, underscores or hyphens.');
    }
    return requester;
  };
  const validRequester = value => typeof value === 'string' && TARGET_NAME.test(value) ? value : 'unknown';
  const ownerFilter = owner => {
    if (!knownOwner(owner)) throw new GatewayError('owner must name a configured webhook target.');
    return owner;
  };
  let proxyEnabled = proxyState.enabled;
  let switchQueue = Promise.resolve();
  const proxyStatus = () => ({ enabled: proxyEnabled,
    execution: proxyEnabled ? 'codex_gateway' : 'grok_approved_local_shell',
    creditDetection: 'manual_only', subscriptionBalance: 'unknown' });
  const requireProxy = () => {
    if (!proxyEnabled) throw new GatewayError('Codex proxy is disabled. Grok approved local Shell execution is the chosen fallback for project work; retain approval and sandbox rules. Re-enable with proxy_set_enabled(enabled: true).');
  };
  const jobs = new Map();
  const requests = new Map();
  let running = null;
  let stopping = false;
  let pumpScheduled = false;
  const terminal = (job) => TERMINAL.includes(job.state);
  const get = (id) => {
    const job = jobs.get(id);
    if (!job) throw new GatewayError('Unknown or expired job ID.');
    return job;
  };
  const toRecord = (job) => ({
    version: 1, id: job.id, kind: job.kind, owner: job.owner, requester: job.requester, requestId: job.requestId,
    fingerprint: job.fingerprint, parentJobId: job.parentJobId ?? null,
    project: job.project ? { id: job.project.id, name: job.project.name ?? null, path: job.project.path } : null,
    mode: job.payload.mode ?? null, state: job.state, progress: job.progress ?? null,
    createdAt: job.createdAt, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    error: job.error ?? null, exitCode: EXIT_CODES[job.state] ?? null,
    result: job.state === 'completed' && job.result
      ? { text: job.result.text, threadId: job.result.threadId ?? null } : null,
    acked: job.acked, ackedAt: job.ackedAt, delivery: job.delivery,
  });
  // Persist only retained jobs; never the prompt (it is not in the record).
  const persist = (job) => { if (store && jobs.get(job.id) === job) void store.save(toRecord(job)); };
  const status = (job) => ({
    jobId: job.id, kind: job.kind, owner: job.owner, notify: job.owner, requester: job.requester, requestId: job.requestId,
    parentJobId: job.parentJobId ?? null, state: job.state, project: job.project?.id,
    mode: job.payload.mode, createdAt: job.createdAt, startedAt: job.startedAt,
    finishedAt: job.finishedAt, progress: job.progress, error: job.error,
    exitCode: EXIT_CODES[job.state] ?? null, acked: job.acked, ackedAt: job.ackedAt, delivery: job.delivery,
  });
  const summary = (job) => ({
    jobId: job.id, requestId: job.requestId, kind: job.kind, owner: job.owner, requester: job.requester,
    project: job.project?.id ?? null, projectName: job.project?.name ?? null, state: job.state,
    createdAt: job.createdAt, finishedAt: job.finishedAt ?? null, error: job.error ?? null,
    acked: job.acked, delivery: job.delivery,
  });
  const notifyFinished = (job) => {
    // Explicit allowlist: never send worker output, prompts, paths or raw errors.
    const event = { event: 'codex_job_finished', jobId: job.id, kind: job.kind,
      owner: job.owner, notify: job.owner, route: job.owner, requester: job.requester,
      state: job.state, projectName: job.project?.name ?? null, requestId: job.requestId,
      createdAt: job.createdAt, finishedAt: job.finishedAt,
      error: job.error ? 'Worker failed.' : null };
    job.delivery = { status: 'pending', route: job.owner, attempts: 0, httpStatus: null, at: null };
    persist(job);
    const record = (result) => { job.delivery = normalizeDelivery(result, job.owner); persist(job); };
    // Completion observers must never affect jobs.
    try { Promise.resolve(onJobFinished(event)).then(record, () => record({ status: 'failed' })); }
    catch { record({ status: 'failed' }); }
  };
  const evict = (id, job) => { jobs.delete(id); requests.delete(job.requestId); void store?.remove(id); };
  const prune = () => {
    // Acknowledged jobs go first; unacknowledged results are kept longest.
    for (const eligible of [job => job.acked, () => true]) {
      for (const [id, job] of jobs) {
        if (jobs.size < maxJobs) return;
        if (terminal(job) && eligible(job)) evict(id, job);
      }
    }
  };
  // Restore persisted records. Work that was queued or running when the
  // previous process stopped cannot resume, so it is marked interrupted and
  // left for the owner's jobs_pending instead of being rerun or notified.
  const restored = [...(store?.records ?? [])]
    .filter(record => typeof record.id === 'string' && ['codex', 'openai'].includes(record.kind)
      && typeof record.requestId === 'string' && typeof record.fingerprint === 'string'
      && typeof record.createdAt === 'string' && typeof record.owner === 'string' && TARGET_NAME.test(record.owner))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const record of restored) {
    // Records written before requester existed restore as 'unknown'.
    const job = { id: record.id, kind: record.kind, owner: record.owner, requester: validRequester(record.requester), requestId: record.requestId,
      fingerprint: record.fingerprint, parentJobId: record.parentJobId ?? null,
      project: record.project ?? undefined,
      payload: { ...(record.project ? { projectPath: record.project.path } : {}), ...(record.mode ? { mode: record.mode } : {}) },
      state: record.state, progress: record.progress ?? undefined, createdAt: record.createdAt,
      startedAt: record.startedAt ?? undefined, finishedAt: record.finishedAt ?? undefined, error: record.error ?? undefined,
      result: record.result ? { text: record.result.text, ...(record.result.threadId ? { threadId: record.result.threadId } : {}) } : undefined,
      acked: record.acked === true, ackedAt: record.ackedAt ?? null, delivery: record.delivery ?? null };
    jobs.set(job.id, job);
    requests.set(job.requestId, { fingerprint: job.fingerprint, jobId: job.id });
    if (!terminal(job)) {
      job.state = 'interrupted'; job.progress = 'interrupted';
      job.finishedAt = new Date().toISOString();
      job.error = 'Gateway stopped before the job finished. Check the project before retrying.';
      job.delivery = { status: 'skipped', route: job.owner, attempts: 0, httpStatus: null,
        at: job.finishedAt, reason: 'interrupted at startup' };
      persist(job);
    }
  }
  prune();
  function schedule() {
    if (pumpScheduled || stopping || running) return;
    pumpScheduled = true;
    setImmediate(() => { pumpScheduled = false; pump(); });
  }
  function pump() {
    if (stopping || running) return;
    const job = [...jobs.values()].find((item) => item.state === 'queued');
    if (!job) return;
    running = job;
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    job.controller = new AbortController();
    persist(job);
    const timer = setTimeout(() => {
      job.stopReason ??= 'timed_out'; job.state = 'cancelling'; job.controller.abort();
    }, jobTimeoutMs);
    timer.unref();
    job.promise = (async () => {
      try {
        // Eligibility can disappear while a job waits in the queue.
        if (job.project) {
          const { projects } = await discover();
          if (!projects.some((item) => item.id === job.project.id && item.path === job.project.path)) {
            throw new GatewayError('Project is no longer eligible. Refresh projects_list.');
          }
        }
        job.controller.signal.throwIfAborted();
        const worker = job.kind === 'codex' ? codexWorker : openAIWorker;
        const result = await worker(job.payload, {
          signal: job.controller.signal,
          onProgress: (event) => {
            // Workers emit event names only, never commands, prompts or credentials.
            if (typeof event === 'string' && /^[a-z_.]{1,80}$/i.test(event)) job.progress = event;
          },
        });
        if (!result || typeof result.text !== 'string' || result.text.length > 1_048_576) {
          throw new Error('Invalid worker result');
        }
        if (!job.stopReason) { job.result = result; job.state = 'completed'; }
      } catch (error) {
        if (!job.stopReason) {
          job.state = 'failed';
          job.error = error instanceof GatewayError ? error.message
            : 'Worker failed. Check local login, model configuration, permissions, or output limits.';
        }
      } finally {
        clearTimeout(timer);
        if (job.stopReason) job.state = job.stopReason;
        job.finishedAt = new Date().toISOString();
        // Requests retain a digest, not the input. CLI session retention is separate.
        delete job.payload.prompt;
        notifyFinished(job);
        running = null;
        schedule();
      }
    })();
  }
  async function resolveProject(id) {
    const { projects } = await discover();
    const project = projects.find((item) => item.id === id);
    if (!project) throw new GatewayError('Unknown or ineligible project. Use projects_list first.');
    return project;
  }
  // Keep fingerprints of pre-requester requests stable: the requester joins the
  // identity only when it differs from the (configured) owner and is known.
  function withRequester(identity, requester, owner) {
    return requester && requester !== 'unknown' && requester !== owner ? { ...identity, requester } : identity;
  }
  function requestFingerprint(input) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }
  function retry(requestId, identity) {
    const previous = requests.get(requestId);
    if (!previous) return null;
    if (previous.fingerprint !== requestFingerprint(identity)) throw new GatewayError('requestId already belongs to a different request.');
    return status(get(previous.jobId));
  }
  function enqueue(kind, payload, requestId, project, identity, owner = defaultWebhook, parentJobId = null, requester = 'unknown') {
    if (stopping) throw new GatewayError('Gateway is shutting down.');
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(requestId)) {
      throw new GatewayError('Supply a requestId of 1–100 letters, digits, dots, colons, underscores or hyphens.');
    }
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 32_000) {
      throw new GatewayError('Prompt must contain 1–32000 characters.');
    }
    const fingerprint = requestFingerprint(identity);
    const previous = requests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new GatewayError('requestId already belongs to a different request.');
      return status(get(previous.jobId));
    }
    if (kind === 'codex') requireProxy();
    if ([...jobs.values()].filter((job) => !terminal(job)).length >= maxQueue) {
      throw new GatewayError('Job queue is full. Wait for a task to finish.');
    }
    prune();
    if (jobs.size >= maxJobs) throw new GatewayError('Job capacity reached.');
    const job = { id: randomUUID(), kind, payload: { ...payload }, requestId, fingerprint, project, owner, requester, parentJobId,
      state: 'queued', createdAt: new Date().toISOString(), progress: 'queued', acked: false, ackedAt: null, delivery: null };
    jobs.set(job.id, job);
    requests.set(requestId, { fingerprint, jobId: job.id });
    persist(job);
    schedule();
    return status(job);
  }
  const newestFirst = (field) => (a, b) => (b[field] ?? '').localeCompare(a[field] ?? '');
  const service = {
    proxyStatus,
    setProxyEnabled(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(new GatewayError('enabled must be a boolean.'));
      const change = switchQueue.then(async () => {
        try { await proxyState.persist(enabled); }
        catch { throw new GatewayError('Cannot persist proxy mode in private runtime configuration. Check directory permissions; mode was not changed.'); }
        proxyEnabled = enabled;
        return proxyStatus();
      });
      switchQueue = change.catch(() => {});
      return change;
    },
    async listProjects() {
      const result = await discover();
      return { ...result, backends: { codex: proxyEnabled, openai: Boolean(openAIWorker) } };
    },
    async startCodex({ project: id, prompt, mode = 'read-only', requestId, notify, owner, requester }) {
      const target = explicitOwner({ notify, owner });
      owner = target?.owner ?? defaultWebhook;
      requester = explicitRequester(requester) ?? target?.name ?? 'unknown';
      if (!['read-only', 'workspace-write', 'workspace-write-git'].includes(mode)) throw new GatewayError('Unsupported sandbox mode.');
      const identity = withRequester({ kind: 'codex', project: id, prompt, mode, notify: owner }, requester, owner);
      const existing = retry(requestId, identity);
      if (existing) return existing;
      requireProxy();
      const project = await resolveProject(id);
      return enqueue('codex', { projectPath: project.path, prompt, mode }, requestId, project, identity, owner, null, requester);
    },
    async followup({ jobId, prompt, requestId, notify, owner, requester }) {
      // Without an explicit target the followup belongs to the parent's owner
      // and, without an explicit requester, to the parent's requester.
      const target = explicitOwner({ notify, owner });
      const explicit = target?.owner;
      const named = explicitRequester(requester) ?? target?.name;
      const identity = withRequester({ kind: 'followup', jobId, prompt, notify: explicit ?? null }, named ?? null, explicit ?? null);
      const existing = retry(requestId, identity);
      if (existing) return existing;
      requireProxy();
      const previous = get(jobId);
      if (previous.kind !== 'codex' || previous.state !== 'completed' || !previous.result?.threadId) {
        throw new GatewayError('Only a completed Codex job with a session ID can be continued.');
      }
      const project = await resolveProject(previous.project.id);
      return enqueue('codex', { projectPath: project.path, prompt, mode: previous.payload.mode,
        threadId: previous.result.threadId }, requestId, project, identity, explicit ?? previous.owner ?? defaultWebhook, previous.id,
        named ?? validRequester(previous.requester));
    },
    async startOpenAI({ prompt, requestId, notify, owner, requester }) {
      const target = explicitOwner({ notify, owner });
      owner = target?.owner ?? defaultWebhook;
      requester = explicitRequester(requester) ?? target?.name ?? 'unknown';
      if (!openAIWorker) throw new GatewayError('OpenAI text backend is not configured on this computer.');
      return enqueue('openai', { prompt }, requestId, undefined,
        withRequester({ kind: 'openai', prompt, notify: owner }, requester, owner), owner, null, requester);
    },
    getStatus(id) { return status(get(id)); },
    getResult(id) {
      const job = get(id);
      return { ...status(job), result: job.state === 'completed' ? job.result.text : null };
    },
    listPending({ owner } = {}) {
      ownerFilter(owner);
      const items = [...jobs.values()].reverse()
        .filter(job => job.owner === owner && terminal(job) && !job.acked)
        .sort(newestFirst('finishedAt')).map(summary);
      return { owner, count: items.length, jobs: items };
    },
    listJobs({ owner, limit = 20 } = {}) {
      ownerFilter(owner);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new GatewayError('limit must be an integer from 1 to 100.');
      const items = [...jobs.values()].reverse().filter(job => job.owner === owner)
        .sort(newestFirst('createdAt')).slice(0, limit).map(summary);
      return { owner, count: items.length, jobs: items };
    },
    ack({ jobId, owner } = {}) {
      ownerFilter(owner);
      const job = get(jobId);
      if (job.owner !== owner) throw new GatewayError('This job belongs to another owner. Acknowledge only your own jobs.');
      if (!terminal(job)) throw new GatewayError('Only a finished job can be acknowledged.');
      if (!job.acked) { job.acked = true; job.ackedAt = new Date().toISOString(); persist(job); }
      return summary(job);
    },
    cancel(id) {
      const job = get(id);
      if (terminal(job)) return status(job);
      job.stopReason ??= 'cancelled';
      if (job.state === 'queued') {
        job.state = 'cancelled'; job.finishedAt = new Date().toISOString(); delete job.payload.prompt;
        notifyFinished(job);
      } else { job.state = 'cancelling'; job.controller.abort(); persist(job); }
      return status(job);
    },
    async close() {
      stopping = true;
      for (const job of jobs.values()) if (!terminal(job)) service.cancel(job.id);
      if (running?.promise) await running.promise;
      await store?.flush?.();
    },
  };
  return service;
}
