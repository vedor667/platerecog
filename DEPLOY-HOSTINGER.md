# Deploying to a Hostinger VPS (Node + ANPR API)

This is the production path: a Node/Express app serves the frontend **and**
proxies images to the Plate Recognizer ANPR API. No Python/ML runs on the VPS.

```
phone (HTTPS) ──► nginx :443 ──► Node app :3000 ──► Plate Recognizer API
                  (TLS, your        /recognize       (Thai plate + box)
                   domain)          static frontend
```

## 0. Get an ANPR token

Sign up at https://app.platerecognizer.com/ and copy your API **token**
(free tier covers prototyping). You'll put it in `.env` below.

## 1. Point a domain at the VPS

Camera + HTTPS require a real domain. In your DNS, add an **A record** for
`plate.yourdomain.com` → your VPS IP. (Hostinger hPanel > DNS, or your
registrar.)

## 2. SSH in and install Node + tools

```bash
ssh root@YOUR_VPS_IP

# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx git
npm install -g pm2          # keeps the app running + restarts on reboot
```

(If your Hostinger VPS template already ships Node, skip the NodeSource step.)

## 3. Upload the project

Either `git clone` your repo, or upload the folder via SFTP to `/var/www/lpr`.
You only need the `server/` and `frontend/` folders on the VPS.

```bash
cd /var/www/lpr/server
npm install --omit=dev
cp .env.example .env
nano .env          # paste PLATE_API_TOKEN, save
```

## 4. Run it with PM2

```bash
pm2 start server.js --name lpr
pm2 save
pm2 startup        # run the command it prints, so it survives reboots
```

Check locally on the VPS: `curl http://localhost:3000/health`
→ should show `"token_configured": true`.

## 5. nginx reverse proxy

```bash
nano /etc/nginx/sites-available/lpr
```

```nginx
server {
    listen 80;
    server_name plate.yourdomain.com;

    client_max_body_size 10M;          # allow photo uploads

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/lpr /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Now `http://plate.yourdomain.com` should load the app.

## 6. HTTPS (required for the camera)

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d plate.yourdomain.com
```

Certbot edits nginx to serve `:443` with auto-renewing Let's Encrypt certs.
Open **https://plate.yourdomain.com** on your phone — the camera will work.

## Updating later

```bash
cd /var/www/lpr && git pull        # or re-upload changed files
cd server && npm install --omit=dev
pm2 restart lpr
```

## Firewall

Make sure the VPS firewall allows 80 and 443 (Hostinger panel or `ufw`):

```bash
ufw allow 80 && ufw allow 443 && ufw allow OpenSSH && ufw enable
```

## Notes

- The frontend calls `/recognize` on the **same origin**, so there's no CORS or
  mixed-content issue once HTTPS is on.
- Keep `.env` out of git (already in `.gitignore`). The token lives only on the VPS.
- Costs: VPS is flat-rate; ANPR API is per-call (watch the free-tier quota).
- The Python `backend/` is now optional — keep it only if you later want to
  self-host the ML instead of using the API.
