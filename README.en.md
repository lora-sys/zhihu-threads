# Zhihu Threads

[中文](./README.md)

![Zhihu Threads project illustration](./assets/readme/lora-v3-project-zhihu-threads-en.webp)

Turn a question into a learning thread grounded in selected Zhihu excerpts. The user chooses sources; AI explains candidates and organizes the selected material into learning nodes, follow-up questions and self-tests.

These illustrations use the existing Lora Field Notes characters and paper-based visual style. They explain the workflow and are not product screenshots.

## How it works

![The user chooses the evidence before AI builds the learning thread](./assets/readme/lora-v3-zhihu-workflow-en.webp)

Clarify the learning intent, search for answer or article excerpts, choose the sources, and build a thread. AI does not select sources on the user's behalf. Thread follow-up answers use the current thread's excerpts and retain unknown or evidence_gap states when evidence is insufficient.

## Start locally

```bash
pnpm install
pnpm dev
```

Open the address printed by the development server. Do not assume a fixed port.

```bash
pnpm check
pnpm test
pnpm build
```

## Implementation

The application uses TanStack Start and TanStack Router, TypeScript, Tailwind CSS, Effect and SQLite through better-sqlite3. The repository includes evaluation datasets, JSON execution traces and a local /evals dashboard. Evaluation counts describe the repository's checks, not guaranteed live-model quality.

## Source boundaries

Use summary-level ContentText returned by the official API. Do not treat an excerpt as a complete article, invent missing article bodies, or present a later source as proof that an earlier author was wrong. Source types and links remain visible. Credentials and private local state must not be committed.

See the Chinese README for the full project layout and evaluation commands.

## License

MIT
