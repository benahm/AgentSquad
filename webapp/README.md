Cette webapp Next.js suit une structure plus idiomatique :

- `components/` pour les composants et la presentation
- `server/` pour les services serveur et les endpoints API

## Demarrage

Installez les dependances avec Bun :

```bash
bun install
```

Lancez ensuite le serveur de developpement :

```bash
bun dev
```

Puis ouvrez [http://localhost:3000](http://localhost:3000).

## Structure

- `app/`: routes Next.js
- `components/`: vues et styles UI
- `server/`: config, services et utilitaires serveur

## Endpoint disponible

Health check :

```bash
curl http://localhost:3000/api/health
```

Reponse attendue :

```json
{
  "ok": true,
  "health": {
    "status": "ok"
  }
}
```

La partie backend metier pour les agents, taches et echanges sera ajoutee ensuite sur cette base.
