# Changelog

## Unreleased

- Support named HTTPS webhook targets, optional URL files validated at startup, and default target selection while preserving legacy `webhook` as `default`. Reject ambiguous default targets and invalid configured defaults.
- Accept and validate `notify` on Codex starts and followups; retain the resolved target on jobs, include it in metadata-only completion events and request deduplication, and route delivery to that target. Document MCP inputs and cover legacy routing, named targets, unknown names, and URL-file validation with fixture tests.

- Add optional HTTPS job-completion webhooks with credentials read only from a private key file, metadata-only payloads for every terminal state, a 10-second timeout, and one retry after 5 seconds for network errors or HTTP 5xx. Delivery failures do not affect jobs; redirects are not followed and logs contain only fixed delivery status messages.
- Validate webhook URL, header settings and key path in the existing configuration; absent configuration and missing or empty key files disable delivery.
- Preserve the 64 MiB Codex JSONL stream allowance while enforcing a separate 1 MiB UTF-8 result limit and 1 MiB diagnostic limit. Remove the worker backup file.
- Add local HTTP fixture coverage for webhook delivery and failure handling, terminal-state notifications, configuration validation, and stream/result bounds.
