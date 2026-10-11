# Deploying AUCTONIQ to a VPS

Target: **Ubuntu 24.04 LTS, Mumbai, 2 vCPU / 4 GB / 100 GB.**

Everything below is copy-pasteable in order. It takes roughly 30–45 minutes,
most of it waiting on `pip install torch`.

The result: AUCTONIQ on port 80, managed by systemd, behind nginx, restarting on
crash and on reboot, with the auction WebSocket proxied correctly.

> **Architecture note.** This is the systemd deployment, not the Docker one.
> Both are supported and both are verified; this one is lighter on a single VM
> (no 5 GB image) and makes a deploy `git pull && systemctl restart`. If you
> would rather run the container, the repository root `Dockerfile` is the one
> that was built and tested — but do not run both.

---

## What you need before starting

- The server's IP address and SSH access as a sudo-capable user.
- Your `ipl_auction_rag_backend/.env`, which is **not in git** and never should
  be. You will copy it up by hand in step 7.

---

## 1. First login and system update

```bash
ssh ubuntu@YOUR_SERVER_IP
sudo apt update && sudo apt upgrade -y
```

Confirm you got the interpreter you expect. It should say 3.12.x:

```bash
python3 --version
```

> If this reports 3.14, you are on Ubuntu 26.04, not 24.04. It will still work,
> but see the note at the bottom of this file before continuing.

## 2. System packages

```bash
sudo apt install -y git curl build-essential python3-venv python3-dev nginx ufw
```

`build-essential` and `python3-dev` are insurance. Every pin in
`requirements.txt` has a prebuilt wheel for this platform, so nothing should
compile — but a source build that fails for want of a compiler wastes the whole
install, and the packages cost a few hundred MB on a 100 GB disk.

## 3. Node 24

Ubuntu's own `nodejs` package is far too old to build this frontend.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v24.x
```

Node 24 matches what the Dockerfile uses. A different major is the usual source
of "it built on my machine".

## 4. The service user and directory

```bash
sudo useradd --system --home /opt/auctoniq --shell /usr/sbin/nologin auctoniq
sudo mkdir -p /opt/auctoniq
sudo chown auctoniq:auctoniq /opt/auctoniq
```

A dedicated unprivileged user, because this process parses every WebSocket frame
and SCOUT query it receives and drives a real Chromium at scraped pages. If any
of that is ever exploited, the blast radius should be one directory.

## 5. Clone

```bash
sudo -u auctoniq git clone https://github.com/ParsanjeetSingh312/Auction-Console.git /opt/auctoniq
cd /opt/auctoniq
```

## 6. Python environment

**Install CPU torch first.** This is the single most important line in the file:

```bash
sudo -u auctoniq python3 -m venv /opt/auctoniq/.venv
sudo -u auctoniq /opt/auctoniq/.venv/bin/pip install --upgrade pip
sudo -u auctoniq /opt/auctoniq/.venv/bin/pip install \
    --index-url https://download.pytorch.org/whl/cpu torch
```

A plain `pip install torch` from PyPI pulls the **CUDA** build — several GB of
NVIDIA runtime on a machine with no GPU. Naming the CPU index first means
`sentence-transformers` later finds its requirement already satisfied and does
not fetch the CUDA build over the top. (On ARM this matters even more: since
torch 2.11 a bare PyPI install on arm64 Linux defaults to a CUDA build.)

Then everything else:

```bash
sudo -u auctoniq /opt/auctoniq/.venv/bin/pip install \
    -r /opt/auctoniq/ipl_auction_rag_backend/requirements.txt
```

Verify you got the CPU build:

```bash
/opt/auctoniq/.venv/bin/python -c "import torch; print(torch.__version__)"
# expect something ending in +cpu, e.g. 2.14.1+cpu
```

## 7. Playwright's Chromium

Needs root, because `--with-deps` apt-installs about thirty shared libraries:

```bash
sudo PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    /opt/auctoniq/.venv/bin/python -m playwright install --with-deps chromium
sudo chmod -R a+rX /opt/ms-playwright
```

`chromium`, never `chrome` — the branded channel has no aarch64 build and is
blocked there, and we want one command that works on both architectures.

`/opt/ms-playwright` rather than the default: the default lands under the
*installing* user's home, which is root's here, and the `auctoniq` user could
not read it. The `chmod` makes it world-readable; capital `X` sets execute only
on directories and already-executable files, so the browser binary stays
runnable without marking every data file executable.

This path must match `PLAYWRIGHT_BROWSERS_PATH` in `auctoniq.service`. It does.

## 8. Secrets

Copy your local `.env` up. **From your own machine**, not the server:

```bash
scp ipl_auction_rag_backend/.env ubuntu@YOUR_SERVER_IP:/tmp/auctoniq.env
```

Then back on the server:

```bash
sudo install -o auctoniq -g auctoniq -m 600 /tmp/auctoniq.env \
    /opt/auctoniq/ipl_auction_rag_backend/.env
rm /tmp/auctoniq.env
```

Mode `600` so only the service user can read it. Delete the `/tmp` copy — it is
world-readable where you left it.

**Leave `DATABASE_URL` empty.** Players are served from local SQLite, which is
what a VPS with a real disk wants. Postgres was only ever a workaround for
Render's ephemeral filesystem.

## 9. Build the frontend

```bash
cd /opt/auctoniq
sudo -u auctoniq npm ci
sudo -u auctoniq npm run build
```

Without this, the API and WebSocket work and every page request returns 503.

## 10. Populate the database

```bash
cd /opt/auctoniq/ipl_auction_rag_backend
sudo -u auctoniq /opt/auctoniq/.venv/bin/python -m ingestion.data_loader
```

Expect `{'players_loaded': 284, 'vectors_created': 284}` and a log line reading
`Auction metadata matched from Phase 1 pool for 94/284 players`.

This downloads ~1.2 GB of model weights on first run, so give it a few minutes.

## 11. The service

```bash
sudo cp /opt/auctoniq/deploy/auctoniq.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now auctoniq
sudo systemctl status auctoniq
```

Watch it come up:

```bash
sudo journalctl -u auctoniq -f
```

You want `Application startup complete.` Startup takes ~20–40s because both
models are warmed into memory before the first request rather than on it.

Confirm it answers locally before involving nginx:

```bash
curl -s localhost:8000/api/v1/ping          # {"status":"alive"}
curl -s localhost:8000/api/v1/health | head -c 200
```

## 12. nginx

```bash
sudo cp /opt/auctoniq/deploy/nginx.conf /etc/nginx/sites-available/auctoniq
sudo ln -s /etc/nginx/sites-available/auctoniq /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

Let nginx read the built assets it serves directly:

```bash
sudo chmod o+x /opt /opt/auctoniq
sudo chmod -R o+rX /opt/auctoniq/dist
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Removing the `default` site matters — left enabled it also claims port 80 and
whichever matches first wins, which presents as the Ubuntu welcome page instead
of your app.

## 13. Firewall

Ubuntu ships UFW enabled. Without this nginx is unreachable and it looks like a
config problem:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
sudo ufw status
```

Allow SSH **first**. Enabling UFW without it locks you out of your own server.

> Port 8000 is deliberately **not** opened. The app binds `127.0.0.1`, so nginx
> is the only way in. If you ever find yourself opening 8000 to fix something,
> that is the bug.

## 14. Verify

From your own machine:

```bash
curl -s http://YOUR_SERVER_IP/api/v1/ping
curl -s http://YOUR_SERVER_IP/api/v1/health
curl -sI http://YOUR_SERVER_IP/ | head -3
```

Then open `http://YOUR_SERVER_IP/` in a browser and check:

- the landing page renders, including the 3D trophy
- `/data` lists 284 players
- `/auction/live` connects — the WebSocket is the part most likely to be
  misconfigured, and the one this nginx config is most careful about

**Everything works over plain HTTP, live bidding included.** The mixed-content
rule that blocks `ws://` applies only to pages served over `https://`; an
`http://` page may open a `ws://` socket freely, and this console uses no
secure-context-only browser API.

What you *do* give up until step 15: the auctioneer password and admin key cross
the network in clear text. Treat the IP phase as staging, not as where you run a
real auction.

## 15. Domain and HTTPS

Once DNS points at the server:

```bash
sudo sed -i 's/server_name _;/server_name auctoniq.example.com;/' \
    /etc/nginx/sites-available/auctoniq
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d auctoniq.example.com
```

certbot matches server blocks **by name** and can do nothing with the `_`
catch-all, which is why the rename comes first. It then rewrites the file in
place: adds a `listen 443` block with the certificate paths and turns the
port-80 block into a 301 redirect. Renewal installs itself as a timer.

`X-Forwarded-Proto $scheme` is already set, so uvicorn starts reporting https
with no further change.

Optionally add the https origin to `CORS_ORIGINS` in `.env` and restart. Only
needed for `/docs` or a second frontend — the console is same-origin and never
consults CORS.

---

## Updating

```bash
cd /opt/auctoniq
sudo -u auctoniq git pull
sudo -u auctoniq /opt/auctoniq/.venv/bin/pip install -r ipl_auction_rag_backend/requirements.txt
sudo -u auctoniq npm ci && sudo -u auctoniq npm run build
sudo systemctl restart auctoniq
```

Only re-run ingestion when the Excel or `pool_metadata.json` changed.

**A restart disconnects every franchise.** Do it between auctions.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `bad interpreter: /usr/bin/env bash^M` | CRLF `start.sh`. `.gitattributes` prevents this; if it happens, `sed -i 's/\r$//' start.sh`. |
| Every page 503, API fine | No `dist/`. Re-run step 9. |
| 502 Bad Gateway | App not running. `systemctl status auctoniq`, `journalctl -u auctoniq -n 50`. |
| Ubuntu welcome page | `default` site still enabled. Re-run step 12. |
| WebSocket connects then drops after ~60s | `proxy_read_timeout` missing from the ws location. The shipped config sets 3600s. |
| SCOUT queries 504 at 60s | Same, in the `/api/` block. Shipped config sets 300s against the app's 180s Hermes budget. |
| `/health` slow, `sqlite_players` null | `DATABASE_URL` is set and pointing somewhere dead. Empty it. |
| Chromium fails to launch | `PLAYWRIGHT_BROWSERS_PATH` mismatch, or step 7's `chmod` skipped. |
| OOM during `npm run build` | Only on a 2 GB box. Add swap, or build locally and `scp` the `dist/`. |

Useful:

```bash
sudo journalctl -u auctoniq -f                 # app log
sudo tail -f /var/log/nginx/auctoniq.error.log # proxy log
systemd-analyze verify /etc/systemd/system/auctoniq.service
free -h                                        # expect ~1.7 GB used
```

---

## Oracle Cloud Always Free (ARM)

Oracle's free tier gives 2 OCPU / 12 GB Ampere A1 in Mumbai or Hyderabad for
nothing, which is more machine than this app will ever need. Everything in this
runbook works unchanged — but Oracle has four specifics that strand people.

### Provision 6 GB, not 12 GB

This looks like leaving value on the table. It is the opposite.

Oracle **reclaims idle Always Free instances**: over any 7-day window, if CPU
(95th percentile), network AND memory are all under 20%, the instance is
stopped. This app sits at ~1.7 GB:

```
12 GB provisioned  ->  1.7 / 12 = 14%   flagged as idle
 6 GB provisioned  ->  1.7 /  6 = 28%   above the threshold
```

The test is an AND, so clearing any single metric protects you. Taking less of
the allowance is what keeps it. 6 GB is still 3.5x what the app uses.

### Upgrade to Pay-As-You-Go anyway

Counter-intuitive, but PAYG is the right account type even though you intend to
pay nothing:

- Always Free resources stay free on PAYG, indefinitely, inside the limits.
- PAYG is documented as exempt from idle reclamation.
- PAYG accounts get provisioning priority, which is the practical fix for the
  `Out of host capacity` errors that ARM A1 returns constantly.

**Set a budget alert at zero immediately after upgrading.** PAYG has no guard
rail: exceed the free limits and you are billed automatically, where a trial
account simply refuses.

### Open the port TWICE

This is the one that costs an afternoon. Oracle has two independent firewalls
and nginx is unreachable until both are open. The symptom is identical to the
app being down: a connection that hangs, with nothing in any log.

**1. The VCN security list**, in the Oracle console — not on the server at all:

> Networking -> Virtual Cloud Networks -> *your VCN* -> Security Lists ->
> Default Security List -> Add Ingress Rules
>
> Source `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `80,443`

**2. The instance's own iptables.** Oracle's Ubuntu images ship with a preloaded
ruleset that REJECTs everything except SSH, and it is evaluated BEFORE ufw. So
`ufw allow 80,443/tcp` on its own does nothing here:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 7 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

`-I INPUT 6` inserts ABOVE the REJECT rule rather than appending below it, where
it would never be reached. Check the position first with `sudo iptables -L INPUT
--line-numbers` and insert before the REJECT line, whatever number that is.

### ARM is a non-issue

Every compiled dependency has an aarch64 wheel — verified against the pinned
versions, not just latest: torch 2.14.1+cpu (`manylinux_2_28_aarch64`),
pydantic-core 2.46.5, onnxruntime, chromadb, pandas, lxml, psycopg-binary,
tokenizers, safetensors, numpy, scipy, pyarrow. Playwright ships
`py3-none-manylinux_2_17_aarch64` and its Chromium is officially supported on
arm64 Ubuntu. Nothing compiles from source; no step below changes.

One detail that matters more on ARM than x86: step 6's CPU torch index is not
optional there. Since torch 2.11 a bare `pip install torch` on arm64 Linux
resolves to a **CUDA** build.

### Add swap

Oracle's ARM images ship with none, and `npm run build` can spike well above the
steady 1.7 GB:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## If you ended up on Ubuntu 26.04

It ships Python 3.14. Every pinned dependency has a cp314 wheel — I checked,
including `pydantic-core 2.46.5` and `torch 2.14.1+cpu` — so nothing compiles
from source and it will work.

But your test suite and the Docker image are both on 3.12. To keep parity,
build the venv with 3.12 instead:

```bash
sudo add-apt-repository -y ppa:deadsnakes/ppa && sudo apt update
sudo apt install -y python3.12 python3.12-venv
sudo -u auctoniq python3.12 -m venv /opt/auctoniq/.venv
```

Leave `/usr/bin/python3` alone — Ubuntu's own tooling depends on it. Nothing
else changes: `start.sh` prefers `$ROOT/.venv/bin/python` over anything on
`PATH`, so whichever interpreter built the venv is the one that runs the app.
