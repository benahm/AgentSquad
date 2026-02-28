# AgentSquad JSONL layout

AgentSquad persists session state under `.agentsquad/` using JSONL files.

Core files per session:

- `session.jsonl`: latest session snapshot
- `agents.jsonl`: latest agent snapshots
- `tasks.jsonl`: latest task snapshots
- `task-dependencies.jsonl`: append-only dependency records
- `task-status-history.jsonl`: append-only task status history
- `messages.jsonl`: latest message snapshots keyed by id
- `activity-logs.jsonl`: append-only activity logs
- `agent-runs.jsonl`: latest run snapshots
- `events.jsonl`: append-only session events

Agent runtime files remain under `sessions/<sessionId>/agents/<agentId>/`.
