#!/usr/bin/env node
// Usage: node gcg.mjs <tool> ['<json args>'] | node gcg.mjs tools | node gcg.mjs pending <owner> | node gcg.mjs ack <jobId> <owner>
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const dir = process.env.GATEWAY_CONFIG_DIR || `${homedir()}/.config/grok-codex-gateway`;
const token = readFileSync(`${dir}/mcp.token`, 'utf8').trim();
const port = JSON.parse(readFileSync(`${dir}/config.json`, 'utf8')).port || 8765;
// Shortcuts: `pending <owner>` and `ack <jobId> <owner>`; anything else is `<tool> ['<json args>']`.
const argv = process.argv.slice(2);
let [tool] = argv;
let args = argv[1] ? (tool === 'pending' || tool === 'ack' ? null : JSON.parse(argv[1])) : {};
if (tool === 'pending') { tool = 'jobs_pending'; args = { owner: argv[1] }; }
else if (tool === 'ack') { tool = 'job_ack'; args = { jobId: argv[1], owner: argv[2] }; }
const client = new Client({ name: 'grok-bot-local', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
try {
  if (!tool || tool === 'tools') {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: ${(t.description || '').split('\n')[0]}`);
  } else {
    const r = await client.callTool({ name: tool, arguments: args });
    if (r.isError) process.exitCode = 1;
    for (const c of r.content || []) console.log(c.type === 'text' ? c.text : JSON.stringify(c));
    if (r.structuredContent && !(r.content||[]).length) console.log(JSON.stringify(r.structuredContent, null, 2));
  }
} finally { await client.close(); }
