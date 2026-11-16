import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// The key stays in this closure and never enters job state or tool responses.
export function createJobWebhook(config, {
  fetchImpl = fetch, wait = ms => delay(ms, undefined, { ref: false }),
  timeoutMs = 10_000, log = message => console.error(message),
} = {}) {
  return async (event) => {
    if (!config) return;
    const report = status => { try { log(`Webhook: ${status}`); } catch { /* Logging is best effort. */ } };
    try {
      let key;
      try { key = (await readFile(config.keyFile, 'utf8')).trim(); }
      catch (error) { if (error.code !== 'ENOENT') report('key unavailable'); return; }
      if (!key) return;
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
          retry = response.status >= 500 && response.status <= 599;
        } catch { report('delivery failed'); retry = true; }
        if (!retry || attempt === 1) return;
        await wait(5000);
      }
    } catch { report('delivery failed'); }
  };
}

// Targets are normalized and URL files validated when configuration is loaded.
export function createJobWebhooks({ webhooks = {}, defaultWebhook = 'default' }, options) {
  const senders = new Map(Object.entries(webhooks).map(([name, target]) => [name, createJobWebhook(target, options)]));
  return event => senders.get(event.notify ?? defaultWebhook)?.(event);
}
