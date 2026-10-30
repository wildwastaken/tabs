# Tabs

Setlist/tab editor with live transposition, PDF/DOCX export, positioned note boxes, and public tab publishing.

- **Editor**: add songs from the shared library, by Ultimate Guitar link (one or many), or by pasting tab text. Drag to reorder, transpose per song, export PDF/DOCX.
- **Setlists**: saved to the shared database so everyone sees them. Open one to edit it, or append its songs to the current setlist.
- **Songs**: the shared library of chord sheets ("tabs"). Publish a song from the editor to add it.
- Lists can be sorted by date added, date modified, or name (remembered per browser).
- Editing library songs and deleting songs or setlists requires the edit/delete password (`TABS_DELETE_PASSWORD`), entered once and remembered in the browser.
- Ultimate Guitar links are fetched server-side by `/api/fetch-tab`, with public CORS proxies as a browser-side fallback.

The database tables (`public_tabs`, `setlists`) are created or upgraded automatically on first use.

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
- `TABS_DELETE_PASSWORD`: Password required to edit library songs and to delete songs or setlists. Set this to `qoheleth` (or your own value) in production.
- `DISCORD_PUBLISH_WEBHOOK_URL`: Optional server-side secret containing the full Discord webhook URL for publish logs. If unset or blank, Discord notifications are disabled; publishing still works. Never prefix this variable with `NEXT_PUBLIC_` or commit its value.

For Netlify deploys, set `TABS_DELETE_PASSWORD` and `DISCORD_PUBLISH_WEBHOOK_URL` in Site configuration -> Environment variables. Make the webhook variable available to Functions in the deployment context you use, then redeploy. For local development, put the webhook value only in the ignored `.env.local` file.

If a webhook is exposed, delete or rotate it in Discord and store the replacement only in your environment settings. Removing a credential from the current source does not remove it from Git history.

If DB URL is missing or DB driver is unavailable, the API falls back to `data/public-tabs.json`.
