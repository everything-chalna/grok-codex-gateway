import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { loadConfig, readToken } from '../src/config.mjs';

async function fixture(t, config = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
  return directory;
}
test('configuration expands home paths and always restricts the local listener', async (t) => {
  const directory = await fixture(t, { allowedHosts: ['gateway.example.test'], gangliaMappings: { example: '~/example' } });
  const config = await loadConfig(directory);
  assert.deepEqual(config.roots, [homedir()]);
  assert.equal(config.gangliaMappings.example, path.join(homedir(), 'example'));
  assert.deepEqual(config.allowedHosts, ['127.0.0.1:8765', 'localhost:8765', 'gateway.example.test']);
});
test('unknown configuration and relative roots fail closed', async (t) => {
  await assert.rejects(loadConfig(await fixture(t, { disableAuthentication: true })), /Invalid gateway/);
  await assert.rejects(loadConfig(await fixture(t, { roots: ['relative'] })), /absolute paths/);
});
test('token files reject insecure modes, symlinks and documentation placeholders', async (t) => {
  const directory = await fixture(t);
  const token = path.join(directory, 'mcp.token');
  await writeFile(token, 'EXAMPLE_NOT_A_SECRET_DO_NOT_USE_IN_PRODUCTION', { mode: 0o644 });
  await assert.rejects(readToken(directory), /mode 0600/);
  await chmod(token, 0o600);
  await assert.rejects(readToken(directory), /placeholder/);
  const other = await fixture(t);
  await symlink(token, path.join(other, 'mcp.token'));
  await assert.rejects(readToken(other));
});

test('webhook validates HTTPS, headers and file-only credentials with defaults', async (t) => {
  const config = await loadConfig(await fixture(t, { webhook: { url: 'https://example.test/finished' } }));
  assert.deepEqual(config.webhook, { url: 'https://example.test/finished', headerName: 'Authorization',
    headerValuePrefix: 'Bearer ', keyFile: path.join(homedir(), '.config/grok-codex-gateway/webhook.key') });
  for (const webhook of [
    { url: 'http://example.test' }, { url: 'https://user:password@example.test' },
    { url: 'https://example.test', key: 'EXAMPLE_NOT_A_SECRET' },
    { url: 'https://example.test', keyFile: 'relative' },
    { url: 'https://example.test', headerName: 'Bad\nHeader' },
    { url: 'https://example.test', headerValuePrefix: '\r\n' },
    { url: 'https://example.test', headerName: 'Content-Type' },
  ]) await assert.rejects(loadConfig(await fixture(t, { webhook })));
});

test('named webhook configuration rejects invalid targets, defaults and URL sources', async (t) => {
  const target = { url: 'https://example.test/fixture', keyFile: '~/fixture.key' };
  for (const value of [
    { webhooks: { Invalid: target } }, { webhooks: { ['a'.repeat(33)]: target } },
    { webhooks: { main: { url: target.url } } },
    { webhooks: { main: { ...target, urlFile: '~/fixture.url' } } },
    { webhooks: { main: { keyFile: target.keyFile } } },
    { webhooks: { main: { urlFile: 'relative', keyFile: target.keyFile } } },
    { webhook: target, webhooks: { default: target } },
    { defaultWebhook: 'missing', webhooks: { main: target } },
  ]) await assert.rejects(loadConfig(await fixture(t, value)));
  const config = await loadConfig(await fixture(t, { webhooks: { main: target }, defaultWebhook: 'main' }));
  assert.equal(config.defaultWebhook, 'main');
  assert.equal(config.webhooks.main.keyFile, path.join(homedir(), 'fixture.key'));
  const directory = await fixture(t);
  const urlFile = path.join(directory, 'fixture.url');
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ webhook: { urlFile } }));
  await assert.rejects(loadConfig(directory), /Cannot read webhook urlFile/);
  for (const url of ['http://example.test', 'https://user:EXAMPLE_NOT_A_SECRET@example.test', '']) {
    await writeFile(urlFile, url);
    await assert.rejects(loadConfig(directory), /valid HTTPS URL/);
  }
  await writeFile(urlFile, 'https://example.test/fixture\n');
  assert.equal((await loadConfig(directory)).webhooks.default.url, 'https://example.test/fixture');
});
