# node-servers

Runs all your Node servers on a Windows PC as one service. Put a server's folder in `deployment\`, and it runs.

```
C:\Servers\              (any folder you like)
├─ node-servers\         this project
└─ deployment\           your servers, one folder each
   ├─ capri\
   └─ another-app\
```

- **Finds servers by itself.** Every folder in `deployment\` is a server. Folders starting with `_` or `.` are skipped, so renaming one to `_capri` parks it. New folders start within a few seconds, and removed ones stop.
- **Works out how to start each one:** `package.json`'s `start` script (`npm start`), otherwise `server.js`, `index.js`, `app.js` or `main.js`, and `package.json`'s `main` as a last resort. A folder without `node_modules` gets `npm install` first.
- **Starts when the PC turns on**, before anyone logs in. There are no windows to leave open.
- **Restarts any server that crashes**, waiting a little longer each time one keeps crashing (2s, 4s, 8s, up to a minute).
- **Keeps each server up to date.** If a server is a git repo, it checks for new commits every minute. When there are some, it runs the server's `update` script if `package.json` has one (Capri's also rebuilds its desktop app). Otherwise it pulls and runs `npm install` if packages changed. Then it restarts the server; the old version keeps serving while packages install.
- **Updates itself** the same way from this repo.
- **Logs** each server's output to `logs\<name>.log`, keeping the last 5 MB plus the previous file.
- **Restarts a server that hangs**, if you give it a health check (`servers.<folder>.health`): when it stops answering three times in a row, it's restarted.
- **Has a dashboard** at `http://127.0.0.1:3399`, on this PC only, behind a key. It shows:
  - each server's status, uptime, restarts, **memory** (with a small graph), **CPU**, the **ports** it listens on (click one to open it), its git branch and commit, and its health;
  - totals at the top, a search box, and filters for running, problem and stopped servers. The tab's title shows how many servers need attention;
  - each server's **log**, live, with errors and warnings in colour, a filter box, and a full download;
  - the supervisor's own log under **Activity**.

  From the dashboard you can restart, update, stop, start or **turn off** each server (turned-off servers stay off after restarts), restart them all, **edit `settings.json`** (it's checked before saving), and **deploy a new server from GitHub** (clone, install, start).

It needs no packages, only Node.js and Git.

## Setup

1. Install [Node.js](https://nodejs.org) and [Git](https://git-scm.com) on the PC, if they aren't there yet.
2. Make a folder for it all, for example `C:\Servers`, and clone this project into it:
   ```bat
   git clone https://github.com/Unblonded/node-servers.git C:\Servers\node-servers
   ```
3. Double-click **`C:\Servers\node-servers\install.bat`**. It:
   - asks for administrator rights;
   - makes `C:\Servers\deployment`;
   - offers to **move in servers you already have** (paste a folder's path). Moving the whole folder keeps everything in it, including Capri's `data\` folder (everyone's sign-ins and notes) and `.env`. Close the server's window first;
   - offers to **clone servers from GitHub** (paste their addresses);
   - offers to remove Capri's old start-up shortcut (`start-server.bat`), which would start a second copy;
   - asks for **your Windows password**, so the servers run as you before you log in. This is how they can use your git sign-in for private repos. A PIN won't work; with a Microsoft account, use that account's password;
   - offers to stop the PC from sleeping while it's plugged in;
   - starts everything and opens the dashboard.

## Adding and removing servers

- **Add one:** put its folder in `deployment\`, by `git clone`, copying or moving it, or use **Deploy from GitHub** on the dashboard. It's installed and started within a few seconds.
- **Park one:** rename its folder to start with `_` (for example `_old-bot`), or set `"enabled": false` for it in `settings.json`.
- **Remove one:** delete or move its folder. It's stopped first.

## settings.json (optional)

Everything works without it. Copy `settings.example.json` to `settings.json` to change things:

```json
{
  "checkEvery": 60,
  "dashboardPort": 3399,
  "servers": {
    "capri": { "env": { "PORT": "3300" } },
    "old-thing": { "enabled": false },
    "my-bot": { "start": "npm run serve", "update": false }
  }
}
```

| Setting | What it does |
| --- | --- |
| `checkEvery` | How often to check for new commits, in seconds (at least 15). |
| `dashboardPort` | The dashboard's port. A change applies the next time the supervisor starts. |
| `deployment` | Where the servers are, if not `..\deployment`. |
| `servers.<folder>.start` | The command that starts it, instead of what's detected. |
| `servers.<folder>.update` | `false` to never update it, or a command to update it with. |
| `servers.<folder>.env` | Extra environment variables. |
| `servers.<folder>.health` | A port (`3300`) or URL (`http://127.0.0.1:3300/health`) checked every 30 seconds, starting a minute after it starts. Any answer below 500 counts as healthy; three misses in a row restart it. |
| `servers.<folder>.enabled` | `false` to leave it off. It still shows on the dashboard, with a **Turn on** button. |

Changes apply within a few seconds. If the file has a mistake, the last good settings stay in use (new folders are still picked up), and `logs\supervisor.log` says what's wrong. `settings.json`, `logs\` and the dashboard key never go into git, and your servers live outside this folder, so updates never touch them.

## Everyday use

- **`open-dashboard.bat`** opens the dashboard.
- **Logs:** `logs\supervisor.log` (the supervisor) and `logs\<name>.log` (each server). The dashboard's **Log** button shows the latest lines live.
- **Stop a server for a while:** its **Stop** button. It stays stopped until you start it again or the supervisor restarts.
- **Turn a server off for good:** **⋯ → Turn off**. This sets `"enabled": false` in `settings.json`, so it stays off after restarts until you click **Turn on**.
- **Change settings:** the dashboard's **Settings** button edits `settings.json`. It won't save broken JSON.
- **Restart the whole service** (the supervisor and every server, for example to load a new version you committed on this PC): the dashboard's **Restart service** button.
- **Run it by hand instead** (to watch it): double-click `run.cmd`. Close the window to stop it. Don't do this while the service is running.
- **The service itself** is the **Node servers** task in Task Scheduler. *End* stops it and *Run* starts it again; the next run tidies up anything the old one left running.

## Remove it

Double-click **`uninstall.bat`**. It removes the task and stops every server. Your servers, `settings.json` and `logs\` stay, so `install.bat` can set it up again.

## Troubleshooting

- **"The user name or password is incorrect"** while installing: use your Windows account password, not your PIN.
- **A server keeps crashing:** open its log. A port another program already uses is the usual cause. When that's it, the dashboard says which process has the port, with a button to stop that process and start the server.
- **Old copies left running:** if the service is ended hard (Task Scheduler's *End*, a crash), its servers can keep running. The next start finds them (it notes every process each server starts) and stops them first. To restart the service, the dashboard's **Restart service** is cleaner.
- **"Can't tell how to start it":** give its `package.json` a `start` script, or set `servers.<folder>.start` in `settings.json`.
- **Updates fail on a private repo:** run `git pull` once yourself in that folder, so Windows saves your GitHub sign-in. The service runs as you, so it uses the same sign-in.
- **The dashboard says "Open this with open-dashboard.bat":** it needs the key that `open-dashboard.bat` adds to the address.
