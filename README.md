# Tabs

Setlist/tab editor with live transposition, PDF/DOCX export, positioned note boxes, and public tab publishing.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Build currently skips ESLint in `next.config.ts` and still performs type checking.

## Environment variables

Copy `.env.example` to `.env.local` and fill in values:

- `NETLIFY_DATABASE_URL`: Postgres connection URL for public tabs storage.
- `TABS_DELETE_PASSWORD`: Password required to delete published tabs. Set this to `qoheleth` (or your own value) in production.
- `DISCORD_PUBLISH_WEBHOOK_URL`: Optional webhook URL for publish logs.

For Netlify deploys, set `TABS_DELETE_PASSWORD` in Site configuration -> Environment variables.

If DB URL is missing or DB driver is unavailable, the API falls back to `data/public-tabs.json`.
