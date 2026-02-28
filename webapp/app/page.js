import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>webapp</p>
        <h1>Welcome to webapp</h1>
        <p className={styles.description}>
          Cette interface servira a suivre le travail des agents lorsqu&apos;ils
          sont lances.
        </p>
      </section>
    </main>
  );
}
