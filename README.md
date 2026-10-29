# Fam Todo

One shared family todo list. Icelandic UI, installable PWA, live sync, push notifications.
Node 18+, one dependency (`web-push`), data in plain JSON files under `data/`.

## Run

```sh
npm install
node server.js invite "Anna"      # prints a link like https://todo.olafurg.com/?k=...
npm start                          # http://localhost:8080
```

Open the invite link once on each device. The key is remembered (localStorage + cookie, and baked into the Home Screen app).

```sh
node server.js devices             # list devices
node server.js revoke "Anna"       # revoke by name or key
```

Env vars: `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR` (./data), `PUBLIC_URL` (used in invite links), `VAPID_SUBJECT` (mailto: for push).

## Debian setup

```sh
sudo useradd -r -s /usr/sbin/nologin famtodo
sudo git clone <this repo> /opt/famtodo && cd /opt/famtodo && sudo npm ci --omit=dev
sudo chown -R famtodo /opt/famtodo
sudo cp deploy/famtodo.service /etc/systemd/system/ && sudo systemctl enable --now famtodo
sudo -u famtodo PUBLIC_URL=https://todo.olafurg.com node server.js invite "Anna"
```

### Public HTTPS via Cloudflare Tunnel (no open ports)

Service workers and push need HTTPS, so use a tunnel for `todo.olafurg.com`:

```sh
cloudflared tunnel login
cloudflared tunnel create famtodo
cloudflared tunnel route dns famtodo todo.olafurg.com
# ~/.cloudflared/config.yml:
#   tunnel: famtodo
#   credentials-file: /root/.cloudflared/<id>.json
#   ingress:
#     - hostname: todo.olafurg.com
#       service: http://localhost:8080
#     - service: http_status:404
sudo cloudflared service install
```

At home on plain `http://<lan-ip>:8080` the list works, but offline mode and notifications do not (browsers require HTTPS).

## Agent API (OpenClaw etc.)

Give the agent its own key: `node server.js invite "OpenClaw"`. Send it as `Authorization: Bearer <key>`.

| Method | Path | Body | |
|---|---|---|---|
| GET | `/api/items` | | JSON list (active first, then done) |
| GET | `/api/items?format=text` | | `[ ] text  (id)` lines |
| POST | `/api/items` | `{"text":"Mjólk"}` | add (goes to top) |
| PATCH | `/api/items/:id` | `{"done":true}` and/or `{"text":"..."}` | check, uncheck, edit |
| DELETE | `/api/items/:id` | | delete |
| POST | `/api/reorder` | `{"ids":[...]}` | set order of active items |

```sh
curl -s -H "Authorization: Bearer $KEY" localhost:8080/api/items?format=text
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"text":"Mjólk"}' localhost:8080/api/items
```

Agent actions sync live and trigger notifications like anyone else's ("OpenClaw bætti við: Mjólk").

## Files

- `server.js` server + CLI
- `public/` app (index.html, app.js, style.css, sw.js, icons)
- `scripts/icons.js` regenerates icons
- `data/` created at runtime: `db.json` (items, push subs), `devices.json` (keys), `vapid.json` (push keys). Back this up.
