# Cline Web Chat

A mobile-friendly web chat for the [Cline](https://github.com/cline/cline) CLI. It runs on your own machine in Termux on Android and lets you chat with Cline from a phone browser. It works only with the Termux build of Cline (see Requirements).

## Features

- Chat with Cline from any browser; installable as an app (PWA)
- Pick the **provider** and **model** from a sheet under the message box (free models only)
- Choose a **project folder** with a folder browser; Cline works inside that folder
- Stop a running request; partial text is kept
- Shows the tools Cline used, and which model really answered
- Markdown, copy buttons, rename and delete chats, Arabic and English text direction
- Conversations are saved in the browser and survive restarts

## Requirements

- Node.js 18 or newer
- The Cline CLI installed, with at least one provider set up (`cline auth`)

> **Compatibility:** this project was built and tested only with the Termux build of Cline
> ([IChouChiang/cline-termux](https://github.com/IChouChiang/cline-termux), version 3.0.73-termux.1)
> on Android. It relies on that CLI's JSON output and options. It has not been tested with
> other builds of Cline, other Cline versions, or other operating systems, and may not work with them.

## Setup

```bash
npm install
npm start
```

Then open `http://127.0.0.1:3000` in your browser.

## Options

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `CLINE_WEB_PASSWORD` | empty | Password for HTTP Basic auth. Required when `HOST` is not local |
| `ALLOWED_HOSTS` | empty | Extra host names allowed in the `Host` header (comma separated), for a tunnel or domain |
| `CLINE_API_BASE_URL` | `https://api.cline.bot` | Where to fetch the free model list |

Example, reachable from other devices on the same network:

```bash
HOST=0.0.0.0 CLINE_WEB_PASSWORD=choose-a-strong-password ALLOWED_HOSTS=192.168.1.20 npm start
```

Do not expose this server to the internet without HTTPS in front of it, because Basic auth sends the password with each request.

## Notes on providers

- The provider list comes from your Cline settings. Providers you have not set up are shown greyed out, with the `cline auth <name>` command that sets them up.
- Only models with a verified price of zero are offered.
- OpenCode is listed but disabled: it runs its own tools in its own folder, ignores the chosen project folder, and can hang.
- A chat stays in the folder it was started in. Changing the folder starts a new chat.

## Self-test

With the server running, in a second terminal:

```bash
npm run selftest
```

It checks providers, models, folder safety, a real chat inside a temporary folder, follow-up memory, the busy response and Stop. The report is saved to `~/selftest-report.txt` and contains no keys or chat history.

## Security notes

- Cline runs with `--auto-approve true`, so it edits files and runs commands without asking. Every project folder must be inside your home directory (symlinks that leave it are rejected).
- API requests are only accepted for known host names, and cross-site requests are refused.
- The server runs Cline with `CLINE_SESSION_BACKEND_MODE=local`, so the work happens in the folder you chose.
- Conversation metadata is stored in `sessions.json` next to `server.js`. Do not commit that file.

## License

MIT. See [LICENSE](LICENSE). Cline and its logo belong to their owners; this project is not affiliated with Cline.
