# LocalFaves

A small desktop app that remembers your local dev sites and starts them with one click.

- **Saved sites.** Each site has a name, a project folder, a start command, and its own block of ports (5 by default, for example `:3080` to `:3084`).
- **One click.** Click a site's name: LocalFaves runs the start command in that folder, waits until the port answers, then opens it in your browser. If it's already running, the click just opens it.
- **Ports for agents.** "Copy for agent" puts a short note on your clipboard telling an AI agent which ports belong to this project. "Write port note into AGENTS.md / CLAUDE.md" (in the ⋯ menu) saves the same note into the project, so agents read it on their own. Re-writing it updates the note in place instead of adding a second copy.
- **Spotted running.** LocalFaves watches for dev servers running on your PC that it didn't start (from a terminal, or one an agent started) and lists them, so you can save any of them as a site. Recently spotted ones are remembered after they stop.
- **Tray.** Closing the window keeps LocalFaves in the system tray. Right-click the tray icon to start any saved site without opening the window. "Quit" stops the servers LocalFaves started.

## Download

Get the newest Windows build from [Releases](https://github.com/Cyberhex1/localfaves/releases/latest):

- `LocalFaves-Setup-<version>.exe` installs it with Start menu and desktop shortcuts.
- `LocalFaves-<version>-portable-x64.zip`: unzip anywhere and run `LocalFaves.exe`.

The builds aren't code-signed yet, so Windows may show "Windows protected your PC" the first time. Click **More info**, then **Run anyway**.

To start a saved site from a shortcut or script with the installed app: `LocalFaves.exe --start="Roll Zero"`

## Build the installer yourself

```powershell
npm install
npm run dist
```

The installer and zip land in `release\`.

## Run it

```powershell
cd C:\code\localfaves
npm install
npm start
```

To get a Desktop and Start-menu shortcut: `npm run shortcut`

If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once.

`node scripts/selftest.js C:\code` prints the start command LocalFaves would guess for every project in a folder, plus the dev servers it can see running right now.

## Start a site from a shortcut, script or agent

```powershell
C:\code\localfaves\node_modules\electron\dist\electron.exe C:\code\localfaves --start="Roll Zero"
```

This starts the saved site with that name (or the first one whose name contains it) and opens it, without showing the window. Add `--hidden` to just launch LocalFaves into the tray.

## How ports work

Every site gets a block of ports. Each site gets 5 ports, and new sites get the next free block: 3080–3084, then 3090–3094, then 3100–3104 and so on (you can change this in Settings).

When a site starts, LocalFaves:

1. sets `PORT` to the first port (most Node servers, Next.js, Create React App and many others read it),
2. sets `LOCALFAVES_PORT1`, `LOCALFAVES_PORT2`, … for every port in the block,
3. replaces `{port}`, `{port2}`, `{port3}` in the start command, the address and any extra environment variables.

Some tools ignore `PORT` (Vite, Astro, Nuxt), so for those the detected command adds a flag, e.g. `npm run dev -- --port {port} --strictPort`. If a server ends up on a different port anyway, the card shows a warning and the log says which port it picked.

## Where things are stored

Your saved sites live in `%APPDATA%\LocalFaves\localfaves.json`.
