# node-servers

Runs all your Node servers on a Windows PC as one service:

- **Starts when the PC turns on**, before anyone logs in. There are no windows to leave open.
- **Restarts any server that crashes**, waiting a little longer each time one keeps crashing (2s, 4s, 8s, up to a minute).
- **Keeps each server up to date.** If a server's folder is a git repo, it checks for new commits every minute. When there are some, it pulls them, installs packages if they changed (or runs that server's own update command), and restarts the server. The old version keeps serving while packages install.
- **Updates itself** the same way from this repo.
- **Logs** each server's output to `logs\<name>.log`, keeping the last 5 MB plus the previous file.
- **Has a dashboard** at `http://127.0.0.1:3399`, on this PC only, behind a key. It shows each server's status, uptime, restarts, last update and log, and can restart, update, stop or start each one.

It needs no packages, only Node.js and Git.

## Setup

1. Install [Node.js](https://nodejs.org) and [Git](https://git-scm.com) on the PC, if they aren't there yet.
2. Clone this repo somewhere permanent, for example `C:\node-servers`:
   ```bat
   git clone https://github.com/Unblonded/node-servers.git C:\node-servers
   ```
3. Double-click **`install.bat`**. It:
   - asks for administrator rights;
   - makes `servers.json` from the example and opens it in Notepad. Add your servers, save, and close Notepad;
   - checks every server's folder exists;
   - offers to remove Capri's old start-up shortcut (`start-server.bat`), which would start a second copy;
   - asks for **your Windows password**, so the servers run as you before you log in. This is how they can use your git sign-in for private repos. A PIN won't work; with a Microsoft account, use that account's password;
   - offers to stop the PC from sleeping while it's plugged in;
   - starts everything and opens the dashboard.

If Capri's old `Capri server` window is open, close it first: the service runs Capri now, and both can't use the same port.

## servers.json

```json
{
  "checkEvery": 60,
  "dashboardPort": 3399,
  "servers": [
    { "name": "capri", "dir": "C:\\Users\\you\\capri", "start": "node server.js", "update": "node scripts/update.mjs" },
    { "name": "bot", "dir": "C:\\code\\bot", "start": "npm start", "env": { "PORT": "4000" } }
  ]
}
```

| Field | What it does |
| --- | --- |
| `name` | Shown on the dashboard and used for the log file. Letters, numbers, `-`, `_` and `.` only. |
| `dir` | The server's folder. Write backslashes twice (`C:\\code\\bot`), or use forward slashes (`C:/code/bot`). |
| `start` | The command that runs it, as you'd type it in that folder: `node server.js`, `npm start`, `npm run serve`… |
| `env` | Optional extra environment variables. |
| `update` | Optional. Leave it out to pull and `npm install` when packages change. Set a command to run the server's own updater instead (Capri's also rebuilds its desktop app), or `false` to never update it. Folders that aren't git repos are never updated. |
| `enabled` | Optional. `false` keeps a server in the list without running it. |
| `checkEvery` | How often to check for new commits, in seconds (at least 15). |
| `dashboardPort` | The dashboard's port. A change applies the next time the supervisor starts. |

**Saving the file applies it straight away:** new servers start, removed ones stop, and changed ones restart. If the file has a mistake, nothing changes, and `logs\supervisor.log` says what's wrong.

`servers.json`, `logs\` and the dashboard key never go into git, so updates never touch them.

## Everyday use

- **`open-dashboard.bat`** opens the dashboard.
- **Logs:** `logs\supervisor.log` (the supervisor) and `logs\<name>.log` (each server). The dashboard's **Log** button shows the latest lines live.
- **Stop a server for a while:** its **Stop** button. It stays stopped until you start it again or the supervisor restarts.
- **Run it by hand instead** (to watch it): double-click `run.cmd`. Close the window to stop it. Don't do this while the service is running.
- **The service itself** is the **Node servers** task in Task Scheduler. *End* stops it and *Run* starts it again; the next run tidies up anything the old one left running.

## Remove it

Double-click **`uninstall.bat`**. It removes the task and stops every server. `servers.json` and `logs\` stay, so `install.bat` can set it up again.

## Troubleshooting

- **"The user name or password is incorrect"** while installing: use your Windows account password, not your PIN.
- **A server keeps crashing:** open its log. A port another program already uses is the usual cause.
- **Updates fail on a private repo:** run `git pull` once yourself in that folder, so Windows saves your GitHub sign-in. The service runs as you, so it uses the same sign-in.
- **The dashboard says "Open this with open-dashboard.bat":** it needs the key that `open-dashboard.bat` adds to the address.
