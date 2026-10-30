# tabs for Mac

A small Electron app that opens the tabs site in its own window. When you add an
Ultimate Guitar link, the page is loaded from **your Mac's own connection**
instead of the hosting provider's server, so it isn't affected by Ultimate
Guitar blocking Netlify/Vercel.

If a direct page load doesn't return the song, the app opens the Ultimate Guitar
page in a normal window. You see exactly what Ultimate Guitar shows (complete any
check it asks for), and the song is added as soon as the page has loaded.

The app loads the hosted site, so site updates show up without rebuilding the app.

## Run it

```bash
cd desktop
npm install
npm start
```

To point it at another deployment (for example a deploy preview):

```bash
TABS_APP_URL=https://deploy-preview-1--allenstabs.netlify.app npm start
```

The default is `https://allenstabs.netlify.app`; change `APP_URL` in `main.js`
to use a different production URL.

## Build a .dmg

Run on a Mac:

```bash
cd desktop
npm install
npm run dist
```

The installer is written to `desktop/dist/`. It isn't signed with an Apple
Developer ID, so the first time you open it macOS will warn that it can't verify
the developer: right-click the app → **Open** → **Open** (or allow it in System
Settings → Privacy & Security).
