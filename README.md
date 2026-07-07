# CT8 / Serv00 Keepalive Worker

Cloudflare Worker script for keeping CT8 / Serv00 panel accounts active. It can also publish file content to a GitHub repository through the GitHub Contents API.

## Features

- Scheduled CT8 / Serv00 login keepalive
- Manual keepalive trigger
- Telegram success, failure, recovery, and summary notifications
- Optional KV state storage to avoid repeated failure alerts
- GitHub file publish endpoint for creating or updating repo files

## Deploy To Cloudflare Workers

1. Create a new Cloudflare Worker.
2. Copy the contents of `ct8.js` into the Worker editor.
3. Add the required environment variables.
4. Add Cron Triggers if you want scheduled keepalive.
5. Deploy the Worker.

Suggested Cron Triggers:

```text
30 0 * * *
30 13 * * *
```

The script sends a summary when the cron expression matches the values in `summaryCrons`.

## Keepalive Environment Variables

### Required

```text
KEEPALIVE_ACCOUNTS_JSON
```

Example:

```json
[
  {
    "name": "ct8-main",
    "type": "ct8",
    "panel": "https://panel.ct8.pl/",
    "username": "your_username",
    "password": "your_password",
    "ssh": "your_ssh_host"
  },
  {
    "name": "serv00-main",
    "type": "serv00",
    "panel": "https://panel.serv00.com/",
    "username": "your_username",
    "password": "your_password"
  }
]
```

### Optional

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
NOTIFY_KEEPALIVE_SUCCESS
STATE_KV
```

Notes:

- `NOTIFY_KEEPALIVE_SUCCESS` defaults to `true`.
- Set `NOTIFY_KEEPALIVE_SUCCESS=false` if you only want failure and recovery alerts.
- `STATE_KV` is optional, but recommended. Bind a Cloudflare KV namespace with the variable name `STATE_KV`.

## Manual Keepalive

Open this URL in your browser or request it with any HTTP client:

```text
https://your-worker.your-subdomain.workers.dev/?run=1
```

Run keepalive and send a summary:

```text
https://your-worker.your-subdomain.workers.dev/?run=1&summary=1
```

## GitHub Publish

The Worker can create or update a file in a GitHub repository.

### GitHub Environment Variables

```text
GITHUB_TOKEN
GITHUB_OWNER
GITHUB_REPO
```

Optional:

```text
GITHUB_BRANCH
GITHUB_PATH
GITHUB_COMMIT_MESSAGE
GITHUB_COMMITTER_NAME
GITHUB_COMMITTER_EMAIL
PUBLISH_TOKEN
NOTIFY_GIT_SUCCESS
```

Notes:

- `GITHUB_BRANCH` defaults to `main`.
- `GITHUB_PATH` defaults to `index.html`.
- `PUBLISH_TOKEN` is recommended. If set, publish requests must include it.
- `NOTIFY_GIT_SUCCESS` defaults to enabled. Set `NOTIFY_GIT_SUCCESS=false` to disable Telegram success messages for Git publishes.

### GitHub Token Permissions

Create a GitHub fine-grained token with access to the target repository.

Required permission:

```text
Contents: Read and write
```

Save it in Cloudflare Worker variables as `GITHUB_TOKEN`.

### Publish Request

Endpoint:

```text
POST https://your-worker.your-subdomain.workers.dev/git
```

If `PUBLISH_TOKEN` is configured, include:

```text
Authorization: Bearer your_publish_token
```

JSON body:

```json
{
  "path": "index.html",
  "content": "<h1>Hello from Worker</h1>",
  "message": "Publish index page"
}
```

You can override repo settings per request:

```json
{
  "owner": "github_username",
  "repo": "repo_name",
  "branch": "main",
  "path": "public/index.html",
  "content": "<h1>Hello</h1>",
  "message": "Update public page"
}
```

Successful response example:

```json
{
  "ok": true,
  "owner": "github_username",
  "repo": "repo_name",
  "path": "index.html",
  "branch": "main",
  "action": "updated"
}
```

## Quick Test With curl

```bash
curl -X POST "https://your-worker.your-subdomain.workers.dev/git" \
  -H "Authorization: Bearer your_publish_token" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"index.html\",\"content\":\"<h1>Hello</h1>\",\"message\":\"Publish test\"}"
```

## Current Repository

GitHub repository:

```text
https://github.com/lkkkkkkkk911/CT8-Serv00.git
```
