import styles from "./home-page.module.css";

export function HomePage() {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>AgentSquad</p>
        <h1>Structure front/back prete pour la suite.</h1>
        <p className={styles.description}>
          Le front est maintenant pense pour rester dans une couche de presentation, tandis que le back pourra vivre dans des services et endpoints API dedies.
        </p>
        <p className={styles.description}>
          Endpoint disponible: <code>/api/health</code>
        </p>
        <p className={styles.description}>
          La logique SQLite et l&apos;API metier seront implementees ensuite dans la partie serveur.
        </p>
      </section>
    </main>
  );
}
