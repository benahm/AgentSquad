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

- `.agentsquad/` pour l'etat local des sessions, agents, messages et logs
- `.agentsquad/agentsquad.db` pour SQLite

## Providers

Lister les providers configures :

```bash
agentsquad provider list
```

Providers integres :

- `vibe` pour lancer `vibe --prompt "..."`
- `codex` pour lancer `codex exec "..."`
- `claude` pour lancer `claude --print "..."`
- `generic` pour des tests simples en local

## Orchestration

Lancer un objectif projet directement :

```bash
agentsquad "creer moi une todo app"
```

Ou choisir explicitement l'agent principal :

```bash
agentsquad vibe "create a note app"
agentsquad codex "create a note app"
agentsquad claude "create a note app"
```

## Agents

Creer un agent logique :

```bash
agentsquad agent run --role developer --goal "creer une todo app" --task "implementer la page principale"
```

Lister les agents :

```bash
agentsquad agent list
```

Voir un agent :

```bash
agentsquad agent show agent-david-developer
```

Recuperer la tache courante d'un agent :

```bash
agentsquad task get --agent agent-david-developer
```

Assigner une tache :

```bash
agentsquad task assign --agent agent-max-reviewer --goal "creer une todo app" --task "relire la premiere version"
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
