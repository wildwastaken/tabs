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
- `DISCORD_PUBLISH_WEBHOOK_URL`: Optional server-side secret containing the full Discord webhook URL for publish logs. If unset or blank, Discord notifications are disabled; publishing still works. Never prefix this variable with `NEXT_PUBLIC_` or commit its value.

For Netlify deploys, set `TABS_DELETE_PASSWORD` and `DISCORD_PUBLISH_WEBHOOK_URL` in Site configuration -> Environment variables. Make the webhook variable available to Functions in the deployment context you use, then redeploy. For local development, put the webhook value only in the ignored `.env.local` file.

If a webhook is exposed, delete or rotate it in Discord and store the replacement only in your environment settings. Removing a credential from the current source does not remove it from Git history.

If DB URL is missing or DB driver is unavailable, the API falls back to `data/public-tabs.json`.
