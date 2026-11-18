import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// The key stays in this closure and never enters job state or tool responses.
// Resolves to a delivery summary ({status, attempts, httpStatus, reason}) that
// the job service records; it never contains URLs, keys or response bodies.
export function createJobWebhook(config, {
  fetchImpl = fetch, wait = ms => delay(ms, undefined, { ref: false }),
  timeoutMs = 10_000, log = message => console.error(message),
} = {}) {
  return async (event) => {
    if (!config) return { status: 'skipped', reason: 'no target', attempts: 0 };
    const report = status => { try { log(`Webhook: ${status}`); } catch { /* Logging is best effort. */ } };
    let last = { status: 'failed', reason: 'delivery failed', attempts: 0, httpStatus: null };
    try {
      let key;
      try { key = (await readFile(config.keyFile, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') report('key unavailable');
        return { status: 'skipped', reason: 'key unavailable', attempts: 0 };
      }
      if (!key) return { status: 'skipped', reason: 'key unavailable', attempts: 0 };
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.set(config.headerName ?? 'Authorization', `${config.headerValuePrefix ?? 'Bearer '}${key}`);
      const body = JSON.stringify(event);
      for (let attempt = 0; attempt < 2; attempt++) {
        let retry = false;
        try {
          const response = await fetchImpl(config.url, {
            method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
          });
          // Never inspect or log response bodies (including reflected secrets).
          if (response.body) await response.body.cancel();
          report(`HTTP ${response.status}`);
          const ok = response.status >= 200 && response.status <= 299;
          last = ok ? { status: 'delivered', attempts: attempt + 1, httpStatus: response.status }
            : { status: 'failed', reason: 'http error', attempts: attempt + 1, httpStatus: response.status };
          retry = response.status >= 500 && response.status <= 599;
        } catch {
          report('delivery failed');
          last = { status: 'failed', reason: 'network error', attempts: attempt + 1, httpStatus: null };
          retry = true;
        }
        if (!retry || attempt === 1) return last;
        await wait(5000);
      }
    } catch { report('delivery failed'); }
    return last;
  };
}

// Targets are normalized and URL files validated when configuration is loaded.
// A completion goes only to its job owner's target. Other bots are never
// notified unless fallbackToDefault is enabled, and then only the default
// target after the owner's delivery failed.
export function createJobWebhooks({ webhooks = {}, defaultWebhook = 'default', fallbackToDefault = false }, options) {
  const senders = new Map(Object.entries(webhooks).map(([name, target]) => [name, createJobWebhook(target, options)]));
  const send = async (name, event) => {
    const sender = senders.get(name);
    if (!sender) return { status: 'skipped', reason: 'no target', attempts: 0, route: name };
    return { ...(await sender({ ...event, route: name })), route: name };
  };
  return async (event) => {
    const owner = event.owner ?? event.notify ?? defaultWebhook;
    const first = await send(owner, event);
    if (first.status !== 'failed' || !fallbackToDefault || owner === defaultWebhook || !senders.has(defaultWebhook)) return first;
    const second = await send(defaultWebhook, event);
    return { ...second, attempts: first.attempts + second.attempts, fallbackFrom: owner,
      reason: second.status === 'delivered' ? 'fallback after owner failure' : 'owner and fallback failed' };
  };
}
