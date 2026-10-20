# Cline Web Chat

A mobile-friendly web chat for the [Cline](https://github.com/cline/cline) CLI. It runs on your own machine (for example in Termux on Android) and lets you chat with Cline from a phone browser.

## Features

- Chat with Cline from any browser on your network
- Free models only, the same list as the Cline CLI "Free" section
- Stop a running request
- Shows the tools Cline used, and whether they failed
- Markdown rendering with copy buttons for code blocks
- Rename and delete chats
- Choose a project folder inside your home directory
- Conversations are saved in the browser and survive restarts

## Requirements

- Node.js 18 or newer
- The Cline CLI installed and logged in (`cline auth`)

## Setup

```bash
npm install
node server.js
```

Then open `http://127.0.0.1:3000` in your browser.

## Options

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `CLINE_WEB_PASSWORD` | empty | Password for HTTP Basic auth. Required when `HOST` is not local |
| `CLINE_API_BASE_URL` | `https://api.cline.bot` | Where to fetch the free model list |

Example, reachable from other devices on the same network:

```bash
HOST=0.0.0.0 CLINE_WEB_PASSWORD=choose-a-strong-password node server.js
```

Do not expose this server to the internet without HTTPS in front of it, because Basic auth sends the password with each request.

## Security notes

- Cline runs with `--auto-approve true`, so it edits files and runs commands without asking. Every project folder must be inside your home directory.
- Conversation metadata is stored in `sessions.json` next to `server.js`. Do not commit that file.

## License

MIT. See [LICENSE](LICENSE).
