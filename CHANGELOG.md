# Changelog

## Unreleased

- Add an optional `requester` label (who started the job) to `codex_start`, `codex_followup` (inherits the parent's) and `openai_start`; resolve it as explicit requester, else the notify/owner name, else `unknown`. Persist it (old records restore as `unknown`) and include it in job_status, job_result, jobs_pending, jobs_list and the completion webhook.
- Well-formed `notify`/`owner` names without a configured target no longer fail: the job is routed to `defaultWebhook` and the name is recorded as requester. Malformed names are still rejected. Tool descriptions tell bots to always pass `requester` and pass `notify` only with their own target.

- Record an `owner` on every job (the `notify` target, new alias `owner`, or `defaultWebhook`). `codex_followup` now inherits the parent job's owner instead of falling back to the default target; unknown names are still rejected.
- Persist job records (owner, request fingerprint, state, timestamps, exit code, completed result and session ID, acknowledgement, delivery status; never prompts) atomically to `state/jobs/` in the private config directory, restore them at startup, and mark previously unfinished jobs `interrupted`.
- Send completion webhooks only to the owner's target, add `owner` and `route` to the payload, and record delivery status on the job. Failed deliveries are not sent to other bots unless the new `fallbackToDefault` setting is enabled.
- Add MCP tools `jobs_pending`, `job_ack` (refuses another owner's job) and `jobs_list`, plus `gcg.mjs pending|ack` shortcuts. Prefer evicting acknowledged jobs when retention is full.
- Cover owner recording, followup inheritance, pending/ack isolation, persistence across restarts and owner-only webhook routing with fixture tests.

- Support named HTTPS webhook targets, optional URL files validated at startup, and default target selection while preserving legacy `webhook` as `default`. Reject ambiguous default targets and invalid configured defaults.
- Accept and validate `notify` on Codex starts and followups; retain the resolved target on jobs, include it in metadata-only completion events and request deduplication, and route delivery to that target. Document MCP inputs and cover legacy routing, named targets, unknown names, and URL-file validation with fixture tests.

- Add optional HTTPS job-completion webhooks with credentials read only from a private key file, metadata-only payloads for every terminal state, a 10-second timeout, and one retry after 5 seconds for network errors or HTTP 5xx. Delivery failures do not affect jobs; redirects are not followed and logs contain only fixed delivery status messages.
- Validate webhook URL, header settings and key path in the existing configuration; absent configuration and missing or empty key files disable delivery.
- Preserve the 64 MiB Codex JSONL stream allowance while enforcing a separate 1 MiB UTF-8 result limit and 1 MiB diagnostic limit. Remove the worker backup file.
- Add local HTTP fixture coverage for webhook delivery and failure handling, terminal-state notifications, configuration validation, and stream/result bounds.
