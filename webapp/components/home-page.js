"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./home-page.module.css";

const STORAGE_KEY = "agentsquad.sqlite.dbPath";
const MESSAGES_LIMIT = 200;
const LOGS_LIMIT = 200;

function formatDate(value) {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString("fr-FR");
}

function stringifyTaskCounts(tasksByStatus = {}) {
  const entries = Object.entries(tasksByStatus);

  if (!entries.length) {
    return "Aucune task";
  }

  return entries.map(([status, count]) => `${status}: ${count}`).join(" · ");
}

function normalizeError(error) {
  if (!error) {
    return "Une erreur inconnue est survenue.";
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || "Une erreur inconnue est survenue.";
}

async function readJson(response) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const body = await response.text();
    const compactBody = body.replace(/\s+/g, " ").trim();
    const preview = compactBody.slice(0, 180);
    throw new Error(
      `Le serveur a renvoye ${contentType || "une reponse non JSON"} au lieu de JSON.${preview ? ` Apercu: ${preview}` : ""}`
    );
  }

  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error?.message || "La requete a echoue.");
  }

  return payload;
}

function StatCard({ label, value, detail }) {
  return (
    <article className={styles.statCard}>
      <p className={styles.statLabel}>{label}</p>
      <p className={styles.statValue}>{value}</p>
      <p className={styles.statDetail}>{detail}</p>
    </article>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className={styles.emptyState}>
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyDescription}>{description}</p>
    </div>
  );
}

function Section({ title, subtitle, children, aside = null }) {
  return (
    <section className={styles.panel}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function HomePage() {
  const [dbPath, setDbPath] = useState("");
  const [savedPathLoaded, setSavedPathLoaded] = useState(false);
  const [source, setSource] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Renseignez le chemin SQLite pour charger la supervision.");
  const [errorMessage, setErrorMessage] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [streamState, setStreamState] = useState("offline");
  const eventSourceRef = useRef(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setDbPath(stored);
    }
    setSavedPathLoaded(true);
  }, []);

  useEffect(() => {
    if (!savedPathLoaded || !dbPath.trim()) {
      return;
    }

    void connectToDatabase(dbPath, { persist: false, autoSelectFirstSession: true });
    // We intentionally run once after localStorage hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedPathLoaded]);

  useEffect(() => {
    return () => {
      closeStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeStream() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStreamState("offline");
  }

  async function connectToDatabase(nextDbPath, options = {}) {
    const trimmedPath = nextDbPath.trim();

    if (!trimmedPath) {
      setErrorMessage("Le chemin SQLite est requis.");
      return;
    }

    closeStream();
    setIsConnecting(true);
    setErrorMessage("");
    setStatusMessage("Connexion a la base SQLite en cours...");

    try {
      const sourcePayload = await readJson(
        await fetch("/api/data-sources", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            dbPath: trimmedPath,
          }),
        })
      );

      const sessionsPayload = await readJson(
        await fetch(`/api/data-sources/${sourcePayload.source.id}/sessions`, {
          cache: "no-store",
        })
      );

      setSource(sourcePayload.source);
      setSessions(sessionsPayload.sessions);

      if (options.persist !== false) {
        window.localStorage.setItem(STORAGE_KEY, trimmedPath);
      }

      const requestedSessionId = options.preferredSessionId || selectedSessionId;
      const existingSession = sessionsPayload.sessions.find((entry) => entry.id === requestedSessionId);
      const nextSessionId = existingSession
        ? existingSession.id
        : options.autoSelectFirstSession !== false
          ? sessionsPayload.sessions[0]?.id || ""
          : "";

      setSelectedSessionId(nextSessionId);

      if (!sessionsPayload.sessions.length) {
        setSnapshot(null);
        setStatusMessage("Base connectee, mais aucune session n'a ete trouvee.");
        return;
      }

      setStatusMessage(`Base connectee. ${sessionsPayload.sessions.length} session(s) detectee(s).`);

      if (nextSessionId) {
        await loadSession(sourcePayload.source.id, nextSessionId);
      }
    } catch (error) {
      setSource(null);
      setSessions([]);
      setSelectedSessionId("");
      setSnapshot(null);
      setErrorMessage(normalizeError(error));
      setStatusMessage("Impossible de charger la base SQLite.");
    } finally {
      setIsConnecting(false);
    }
  }

  async function loadSession(sourceId, sessionId) {
    if (!sourceId || !sessionId) {
      return;
    }

    closeStream();
    setIsLoadingSession(true);
    setErrorMessage("");
    setStatusMessage(`Chargement de la session ${sessionId}...`);

    try {
      const params = new URLSearchParams({
        messagesLimit: String(MESSAGES_LIMIT),
        logsLimit: String(LOGS_LIMIT),
      });
      const sessionPayload = await readJson(
        await fetch(`/api/data-sources/${sourceId}/sessions/${sessionId}?${params.toString()}`, {
          cache: "no-store",
        })
      );

      setSnapshot(sessionPayload);
      setSelectedSessionId(sessionId);
      setStatusMessage(`Session ${sessionId} chargee. Flux live en preparation...`);
      openLiveStream(sourceId, sessionId);
    } catch (error) {
      setSnapshot(null);
      setErrorMessage(normalizeError(error));
      setStatusMessage(`Impossible de charger la session ${sessionId}.`);
    } finally {
      setIsLoadingSession(false);
    }
  }

  function openLiveStream(sourceId, sessionId) {
    closeStream();
    setStreamState("connecting");

    const params = new URLSearchParams({
      messagesLimit: String(MESSAGES_LIMIT),
      logsLimit: String(LOGS_LIMIT),
    });
    const stream = new EventSource(
      `/api/data-sources/${sourceId}/sessions/${sessionId}/stream?${params.toString()}`
    );

    stream.addEventListener("snapshot", (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot(payload);
      setStatusMessage(`Session ${sessionId} synchronisee en direct.`);
      setStreamState("live");
    });

    stream.addEventListener("session.changed", (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          session: payload.session,
          summary: payload.summary,
        };
      });
    });

    stream.addEventListener("agents.changed", (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          agents: payload.items,
          summary: payload.summary,
        };
      });
    });

    stream.addEventListener("tasks.changed", (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          tasks: payload.items,
          summary: payload.summary,
        };
      });
    });

    stream.addEventListener("messages.appended", (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        const nextMessages = [...current.messages, ...payload.items].slice(-MESSAGES_LIMIT);
        return {
          ...current,
          messages: nextMessages,
          summary: {
            ...current.summary,
            messageCount: nextMessages.length,
            lastActivityAt: payload.items.at(-1)?.createdAt || current.summary.lastActivityAt,
          },
        };
      });
    });

    stream.addEventListener("logs.appended", (event) => {
      const payload = JSON.parse(event.data);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }

        const nextLogs = [...current.logs, ...payload.items].slice(-LOGS_LIMIT);
        return {
          ...current,
          logs: nextLogs,
          summary: {
            ...current.summary,
            logCount: nextLogs.length,
            lastActivityAt: payload.items.at(-1)?.createdAt || current.summary.lastActivityAt,
          },
        };
      });
    });

    stream.addEventListener("error", (event) => {
      if (event?.data) {
        const payload = JSON.parse(event.data);
        setErrorMessage(payload.message || "Le flux live a remonte une erreur.");
      } else {
        setErrorMessage("Connexion live interrompue.");
      }

      setStreamState("offline");
    });

    eventSourceRef.current = stream;
  }

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>AgentSquad Monitor</p>
          <h1>Sessions, tasks, agents, messages et logs SQLite en direct.</h1>
          <p className={styles.description}>
            Entrez le chemin de la base SQLite, on le garde dans le navigateur, puis la page charge la session et
            suit ce qui change en live.
          </p>
        </div>

        <div className={styles.connectionCard}>
          <label className={styles.fieldLabel} htmlFor="db-path">
            Chemin SQLite
          </label>
          <div className={styles.connectionRow}>
            <input
              id="db-path"
              className={styles.input}
              placeholder="C:\\Users\\...\\agentsquad.db ou /mnt/c/.../agentsquad.db"
              value={dbPath}
              onChange={(event) => setDbPath(event.target.value)}
            />
            <button
              className={styles.primaryButton}
              type="button"
              onClick={() => connectToDatabase(dbPath, { persist: true, autoSelectFirstSession: true })}
              disabled={isConnecting}
            >
              {isConnecting ? "Connexion..." : "Connecter"}
            </button>
          </div>

          <div className={styles.statusRow}>
            <span className={styles.statusBadge} data-state={streamState}>
              {streamState === "live" ? "Live" : streamState === "connecting" ? "Connexion flux" : "Hors ligne"}
            </span>
            <p className={styles.statusText}>{statusMessage}</p>
          </div>

          {errorMessage ? <p className={styles.errorText}>{errorMessage}</p> : null}

          {source ? (
            <div className={styles.metaGrid}>
              <div>
                <span>Source</span>
                <strong>{source.id}</strong>
              </div>
              <div>
                <span>Schema</span>
                <strong>{source.schema}</strong>
              </div>
              <div>
                <span>Tables</span>
                <strong>{source.detectedTables.length}</strong>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className={styles.workspace}>
        <Section
          title="Sessions"
          subtitle="Choisissez une session pour afficher son contenu et ouvrir le suivi live."
        >
          {sessions.length ? (
            <div className={styles.sessionList}>
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={styles.sessionButton}
                  data-active={session.id === selectedSessionId}
                  onClick={() => loadSession(source?.id, session.id)}
                  disabled={isLoadingSession}
                >
                  <span>{session.title || session.id}</span>
                  <strong>{session.status}</strong>
                  <small>{formatDate(session.updatedAt)}</small>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              title="Aucune session chargee"
              description="Connectez une base SQLite AgentSquad pour afficher les sessions disponibles."
            />
          )}
        </Section>

        {snapshot ? (
          <>
            <section className={styles.summaryGrid}>
              <StatCard
                label="Session"
                value={snapshot.session.title || snapshot.session.id}
                detail={`Statut: ${snapshot.session.status}`}
              />
              <StatCard
                label="Agents"
                value={snapshot.summary.agentCount}
                detail={`Manager: ${snapshot.session.managerAgentId || "non defini"}`}
              />
              <StatCard
                label="Tasks"
                value={snapshot.tasks.length}
                detail={stringifyTaskCounts(snapshot.summary.tasksByStatus)}
              />
              <StatCard
                label="Derniere activite"
                value={formatDate(snapshot.summary.lastActivityAt)}
                detail={`${snapshot.messages.length} messages · ${snapshot.logs.length} logs affiches`}
              />
            </section>

            <div className={styles.columns}>
              <Section
                title="Agents"
                subtitle={`${snapshot.agents.length} agent(s) dans la session`}
              >
                <div className={styles.cardList}>
                  {snapshot.agents.map((agent) => (
                    <article key={agent.id} className={styles.infoCard}>
                      <div className={styles.infoTopline}>
                        <strong>{agent.name}</strong>
                        <span>{agent.status}</span>
                      </div>
                      <p className={styles.infoMeta}>
                        {agent.role} · {agent.kind} · {agent.providerId}
                      </p>
                      <p className={styles.infoMeta}>Task courante: {agent.currentTaskTitle || "Aucune"}</p>
                      <p className={styles.infoSubtle}>Id: {agent.id}</p>
                    </article>
                  ))}
                </div>
              </Section>

              <Section
                title="Tasks"
                subtitle={`${snapshot.tasks.length} task(s)`}
              >
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Titre</th>
                        <th>Agent</th>
                        <th>Statut</th>
                        <th>Priorite</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.tasks.map((task) => (
                        <tr key={task.id}>
                          <td>
                            <strong>{task.title}</strong>
                            <span>{task.description}</span>
                          </td>
                          <td>{task.agentName || task.agentId}</td>
                          <td>{task.status}</td>
                          <td>{task.priority}</td>
                          <td>{task.taskType}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>

            <div className={styles.columns}>
              <Section
                title="Messages"
                subtitle={`${snapshot.messages.length} message(s) affiches`}
              >
                {snapshot.messages.length ? (
                  <div className={styles.timeline}>
                    {snapshot.messages.map((message) => (
                      <article key={message.id} className={styles.timelineItem}>
                        <div className={styles.timelineMeta}>
                          <strong>{message.fromAgentName || message.fromType}</strong>
                          <span>→</span>
                          <strong>{message.toAgentName || message.toAgentId || "broadcast"}</strong>
                          <small>{formatDate(message.createdAt)}</small>
                        </div>
                        <p>{message.text}</p>
                        <div className={styles.timelineTags}>
                          <span>{message.messageKind}</span>
                          <span>{message.deliveryStatus}</span>
                          {message.relatedTaskTitle ? <span>{message.relatedTaskTitle}</span> : null}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="Aucun message" description="Les echanges entre agents apparaitront ici." />
                )}
              </Section>

              <Section
                title="Logs live"
                subtitle={`${snapshot.logs.length} log(s) affiches en direct`}
                aside={<span className={styles.liveHint}>Polling SSE toutes les secondes</span>}
              >
                {snapshot.logs.length ? (
                  <div className={styles.logList}>
                    {snapshot.logs.map((log) => (
                      <article key={log.id} className={styles.logItem} data-level={log.level}>
                        <div className={styles.logMeta}>
                          <strong>{log.agentName || log.agentId || "system"}</strong>
                          <span>{log.kind}</span>
                          <small>{formatDate(log.createdAt)}</small>
                        </div>
                        <p>{log.message}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="Aucun log" description="Les activity logs de la session seront visibles ici." />
                )}
              </Section>
            </div>
          </>
        ) : (
          <section className={styles.placeholder}>
            <EmptyState
              title="Aucune session affichee"
              description="Connectez une base, puis choisissez une session pour afficher agents, tasks, messages et logs."
            />
          </section>
        )}
      </section>
    </main>
  );
}
