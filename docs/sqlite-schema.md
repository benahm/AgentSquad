# AgentSquad SQLite Schema

Source of truth: [db.js](/mnt/c/Users/abensaad/Documents/GitHub/AgentSquad/cli/src/core/db.js)

Artifacts:

- Mermaid source: [sqlite-schema.mmd](/mnt/c/Users/abensaad/Documents/GitHub/AgentSquad/docs/sqlite-schema.mmd)
- Rendered SVG: [sqlite-schema.svg](/mnt/c/Users/abensaad/Documents/GitHub/AgentSquad/docs/sqlite-schema.svg)

Main entities:

- `sessions`: project-level execution context
- `agents`: manager and worker agents
- `tasks`: assigned work items and execution status
- `messages`: inter-agent and user-agent communication
- `agent_runs`: concrete executions of an agent
- `artifacts`: files or outputs produced during a session

Coordination model:

- Any agent can contact any other agent in the same session.
- There is no restriction table for allowed contacts.
- `agentsquad task get` should expose the other agents in the session with their role, status, and current task so an agent can decide who to contact.

Relationship highlights:

- One session contains many agents, tasks, messages, runs, and artifacts.
- One agent can own many tasks and many runs.
- Tasks keep a status history and optional dependencies on other tasks.
- Messages can be linked to a task and can reply to other messages.
