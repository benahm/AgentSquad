import { requireDataSource } from "@/server/services/session-monitor";
import {
  getSessionChangeMarkers,
  getSessionSnapshot,
  getSessionSummary,
  listAgents,
  listLogsSince,
  listMessagesSince,
  listTasks,
} from "@/server/jsonl/queries";

const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

function encodeSseEvent(encoder, event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function createCursor(createdAt, id) {
  return {
    createdAt: createdAt || "",
    id: id || "",
  };
}

export function createSessionStream(sourceId, sessionId, searchParams) {
  const source = requireDataSource(sourceId);
  const messagesLimit = Math.min(Number.parseInt(searchParams.get("messagesLimit"), 10) || 200, 1_000);
  const logsLimit = Math.min(Number.parseInt(searchParams.get("logsLimit"), 10) || 200, 1_000);

  const encoder = new TextEncoder();
  let heartbeatTimer = null;
  let pollTimer = null;
  let closed = false;

  return new ReadableStream({
    async start(controller) {
      let polling = false;
      let markers;

      const close = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        controller.close();
      };

      const send = (event, data) => {
        if (closed) {
          return;
        }

        controller.enqueue(encodeSseEvent(encoder, event, data));
      };

      try {
        const snapshot = await getSessionSnapshot(source.workspacePath, sessionId, {
          messagesLimit,
          logsLimit,
        });

        markers = await getSessionChangeMarkers(source.workspacePath, sessionId);
        send("snapshot", snapshot);

        heartbeatTimer = setInterval(() => {
          send("heartbeat", {
            sessionId,
            timestamp: new Date().toISOString(),
          });
        }, HEARTBEAT_INTERVAL_MS);

        pollTimer = setInterval(async () => {
          if (closed || polling) {
            return;
          }

          polling = true;

          try {
            const nextMarkers = await getSessionChangeMarkers(source.workspacePath, sessionId);

            if (nextMarkers.sessionUpdatedAt !== markers.sessionUpdatedAt) {
              const payload = await getSessionSummary(source.workspacePath, sessionId, {
                messagesLimit,
                logsLimit,
              });
              send("session.changed", payload);
            }

            if (nextMarkers.agentsUpdatedAt !== markers.agentsUpdatedAt) {
              const agents = await listAgents(source.workspacePath, sessionId);
              const payload = await getSessionSummary(source.workspacePath, sessionId, {
                messagesLimit,
                logsLimit,
              });
              send("agents.changed", {
                items: agents,
                summary: payload.summary,
              });
            }

            if (nextMarkers.tasksUpdatedAt !== markers.tasksUpdatedAt) {
              const tasks = await listTasks(source.workspacePath, sessionId);
              const payload = await getSessionSummary(source.workspacePath, sessionId, {
                messagesLimit,
                logsLimit,
              });
              send("tasks.changed", {
                items: tasks,
                summary: payload.summary,
              });
            }

            const newMessages = await listMessagesSince(
              source.workspacePath,
              sessionId,
              createCursor(markers.lastMessageCreatedAt, markers.lastMessageId),
              messagesLimit
            );

            if (newMessages.length > 0) {
              const lastMessage = newMessages.at(-1);
              markers.lastMessageCreatedAt = lastMessage.createdAt;
              markers.lastMessageId = lastMessage.id;
              send("messages.appended", { items: newMessages });
            }

            const newLogs = await listLogsSince(
              source.workspacePath,
              sessionId,
              createCursor(markers.lastLogCreatedAt, markers.lastLogId),
              logsLimit
            );

            if (newLogs.length > 0) {
              const lastLog = newLogs.at(-1);
              markers.lastLogCreatedAt = lastLog.createdAt;
              markers.lastLogId = lastLog.id;
              send("logs.appended", { items: newLogs });
            }

            markers.sessionUpdatedAt = nextMarkers.sessionUpdatedAt;
            markers.agentsUpdatedAt = nextMarkers.agentsUpdatedAt;
            markers.tasksUpdatedAt = nextMarkers.tasksUpdatedAt;
          } catch (error) {
            send("error", {
              message: error.message || "Unexpected stream error.",
            });
          } finally {
            polling = false;
          }
        }, POLL_INTERVAL_MS);
      } catch (error) {
        send("error", {
          message: error.message || "Unable to initialize session stream.",
        });
        close();
      }
    },
    cancel() {
      if (closed) {
        return;
      }

      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    },
  });
}
