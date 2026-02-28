# agentsquad-cli

CLI pour lancer et coordonner plusieurs agents CLI via une interface unique.

## Installation

```bash
bun install
```

## Initialisation

```bash
bun run start init
```

Cette commande cree :

- `agentsquad.config.json`
- `.agentsquad/` pour l'etat local des sessions, agents, messages et logs

## Providers

Lister les providers configures :

```bash
agentsquad provider list
```

Config par defaut :

- `codex` en mode `oneshot` via `codex exec`
- `generic` pour des tests simples en local

## Agents

Creer un agent logique :

```bash
agentsquad agent spawn --provider codex --name planner
```

Lister les agents :

```bash
agentsquad agent list
```

Voir un agent :

```bash
agentsquad agent show agent-12345678
```

## Messages

Envoyer un message utilisateur vers un agent :

```bash
agentsquad message send --to agent-12345678 --text "Analyse ce repo"
```

Envoyer un message d'un agent vers un autre :

```bash
agentsquad message send --from agent-a --to agent-b --text "Relis mon plan"
```

Voir l'historique :

```bash
agentsquad message list
agentsquad events
```

Voir les logs :

```bash
agentsquad logs agent-12345678
```

## Installation globale

```bash
bun link
agentsquad --help
```
