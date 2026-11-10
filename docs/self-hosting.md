# Self-hosting Sci-epo

Sci-epo runs as one Bun process with one SQLite database. This guide puts it behind nginx with HTTPS on a Linux server. A deployment has a single owner account; public registration and multiple users are not supported.

On your own computer you do not need any of this: `bun install --frozen-lockfile` and `bun run start` serve the workspace at `http://127.0.0.1:4317` without a login.

## 1. Install

You need Linux (x64 or arm64), [Bun](https://bun.sh) 1.4 or later, nginx and certbot.

```sh
sudo useradd --system --home-dir /var/lib/sci-epo --shell /usr/sbin/nologin sciepo
sudo install -d -o sciepo -g sciepo -m 700 /var/lib/sci-epo
sudo git clone https://github.com/zhang001ziyu/sci-epo.git /opt/sci-epo/releases/first
sudo ln -sfn /opt/sci-epo/releases/first /opt/sci-epo/current
cd /opt/sci-epo/current
sudo bun install --frozen-lockfile
sudo bun run typecheck && sudo bun test ./tests && sudo bun run build
```

The server needs `dist/app.js` from `bun run build` when it runs with `SCIEPO_PREBUILT=true`, as in the service template.

## 2. Create the owner account

The password is read from standard input, hashed with Argon2id and never stored in plaintext. Running the command again for the same email replaces the password and signs out every session.

```sh
read -rs SCIEPO_OWNER_PASSWORD
printf '%s\n' "$SCIEPO_OWNER_PASSWORD" | sudo -u sciepo env \
  SCIEPO_DB_PATH=/var/lib/sci-epo/studio.sqlite \
  SCIEPO_PUBLIC_ORIGIN=https://studio.example.com \
  SCIEPO_OWNER_EMAIL=you@example.com \
  bun run scripts/create-owner.ts
unset SCIEPO_OWNER_PASSWORD
```

## 3. Run the service

Copy [`deploy/sciepo.service`](../deploy/sciepo.service) to `/etc/systemd/system/`, replace the domain and the Bun path (`command -v bun`), then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sciepo.service
journalctl -u sciepo.service -n 20
```

The service listens only on `127.0.0.1:4317`. With `SCIEPO_PUBLIC_ORIGIN` set, every API call needs the owner login, write requests need the session's CSRF token and an exact `Origin`, and session cookies are `__Host-`, `HttpOnly`, `Secure` and `SameSite=Strict`. With `NODE_ENV=production`, the server refuses to start without `SCIEPO_PUBLIC_ORIGIN`.

## 4. HTTPS

Copy [`deploy/nginx.example.conf`](../deploy/nginx.example.conf) to `/etc/nginx/conf.d/sciepo.conf` and replace the domain. Issue the certificate first with the port-80 block alone (or comment out the 443 block), then enable the whole file:

```sh
sudo certbot certonly --webroot -w /var/www/html -d studio.example.com
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Model services

Sign in and open **模型服务** (Model services). Add a connection (OpenAI-compatible Chat Completions or Responses, Anthropic Messages, or Google Gemini), add a model, run its connection test, then assign tested models to the writing, review and revision roles. API keys are encrypted with AES-256-GCM using `/var/lib/sci-epo/provider.key`, which the server creates on first start.

## Backups

Back up the database with the SQLite backup API while the server runs, for example `sqlite3 /var/lib/sci-epo/studio.sqlite ".backup /backup/studio.sqlite"`, and keep a copy of `provider.key`. Encrypted API keys cannot be read without that file; the server refuses to start if the database has encrypted keys but the file is missing.

## Upgrades

1. Put the new version in a new directory under `/opt/sci-epo/releases/` and run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test ./tests` and `bun run build` there.
2. Make sure no generation or review is running, because a restart marks running tasks as failed.
3. Back up the database.
4. Point `/opt/sci-epo/current` at the new directory and run `sudo systemctl restart sciepo.service`.
5. To roll back, point the link back at the previous directory and restart. New versions add tables and optional fields; earlier versions ignore them.
