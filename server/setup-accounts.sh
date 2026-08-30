#!/usr/bin/env bash
# Secure FleetComm relay/accounts deployment. Run as root on the droplet from
# the staged repository. PUBLIC_ADDRESS may be a controlled hostname or a
# public IPv4 address; no domain is required for the IPv4 path.
set -euo pipefail

PUBLIC_ADDRESS="${1:?usage: setup-accounts.sh <public-address> <letsencrypt-email>}"
LE_EMAIL="${2:?missing certificate contact email}"
PUBLIC_IS_IP=0
if [[ "$PUBLIC_ADDRESS" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  PUBLIC_IS_IP=1
  IFS=. read -r -a address_parts <<< "$PUBLIC_ADDRESS"
  for part in "${address_parts[@]}"; do
    (( 10#$part >= 0 && 10#$part <= 255 )) || { echo "invalid public IPv4 address" >&2; exit 1; }
  done
elif [[ ! "$PUBLIC_ADDRESS" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "invalid public address" >&2; exit 1
fi
SECRETS_INPUT="${FLEETCOMM_SECRETS_DIR:-./deploy-secrets}"
if [[ "$SECRETS_INPUT" = /* ]]; then SECRETS_DIR="$SECRETS_INPUT"; else SECRETS_DIR="$PWD/$SECRETS_INPUT"; fi
for name in superuser-password relay-password bootstrap-token; do
  test -s "$SECRETS_DIR/$name" || { echo "missing deployment secret: $name" >&2; exit 1; }
done
SUPW="$(<"$SECRETS_DIR/superuser-password")"
RELAYPW="$(<"$SECRETS_DIR/relay-password")"
BOOTTOK="$(<"$SECRETS_DIR/bootstrap-token")"
SUPW_B64="$(printf '%s' "$SUPW" | base64 | tr -d '\n')"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs npm nginx python3 python3-venv

# Ubuntu's packaged Certbot can lag IP-certificate support.  Certbot 5.4 added
# webroot validation for IP addresses; pin a known compatible release in its
# own root-owned virtual environment so renewal behavior is reproducible.
CERTBOT_ROOT=/opt/fleetcomm-certbot
python3 -m venv "$CERTBOT_ROOT"
"$CERTBOT_ROOT/bin/pip" install --disable-pip-version-check --quiet "certbot==5.7.0"
CERTBOT="$CERTBOT_ROOT/bin/certbot"

id fleetcomm >/dev/null 2>&1 || useradd --system --home /opt/fleetcomm-accounts --shell /usr/sbin/nologin fleetcomm
install -d -m 0755 -o root -g root /opt/fleetcomm-accounts
install -d -m 0700 -o fleetcomm -g fleetcomm /opt/fleetcomm-accounts/data
for dir in server src proto config; do install -d -m 0755 -o root -g root "/opt/fleetcomm-accounts/$dir"; done
install -m 0644 server/accounts-service.js /opt/fleetcomm-accounts/server/
# the WHOLE src/ directory, not a hand-picked list: enumerating the require
# closure by hand is how a missing relay-trust.js crash-looped the service on
# the 2026-08-30 deploy (MODULE_NOT_FOUND). The directory is tiny; copy it all.
install -m 0644 src/*.js /opt/fleetcomm-accounts/src/
install -m 0644 proto/Mumble.proto /opt/fleetcomm-accounts/proto/
install -m 0644 config/22nd-package.json /opt/fleetcomm-accounts/config/
cd /opt/fleetcomm-accounts
test -d node_modules/protobufjs || { npm init -y >/dev/null; npm install --omit=dev --ignore-scripts protobufjs@7 >/dev/null; }

# The accounts API is loopback-only. nginx is the sole public listener and TLS
# terminator; port 8722 is never opened to the internet.
cat > /etc/fleetcomm-accounts.env << ENV
HOST=127.0.0.1
PORT=8722
DATA_DIR=/opt/fleetcomm-accounts/data
SUPW_B64=${SUPW_B64}
MUMBLE_HOST=127.0.0.1
RELAY_PASSWORD=${RELAYPW}
ROOT_CHANNEL="22ND EXPEDITIONARY FLEET"
BOOTSTRAP_TOKEN=${BOOTTOK}
SESSION_TTL_HOURS=12
ENV
chown root:fleetcomm /etc/fleetcomm-accounts.env
chmod 0640 /etc/fleetcomm-accounts.env

cat > /etc/systemd/system/fleetcomm-accounts.service << UNIT
[Unit]
Description=FleetComm Accounts Service
After=network.target mumble-server.service
[Service]
EnvironmentFile=/etc/fleetcomm-accounts.env
ExecStart=$(command -v node) /opt/fleetcomm-accounts/server/accounts-service.js
Restart=always
RestartSec=3
User=fleetcomm
Group=fleetcomm
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
SystemCallArchitectures=native
ReadWritePaths=/opt/fleetcomm-accounts/data
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/nginx/conf.d/fleetcomm-rate.conf << NGINX
limit_req_zone \$binary_remote_addr zone=fleetcomm_login:10m rate=10r/m;
NGINX
ACME_ROOT=/var/www/fleetcomm-acme
install -d -m 0755 "$ACME_ROOT/.well-known/acme-challenge"
cat > /etc/nginx/sites-available/fleetcomm-accounts << NGINX
server {
  listen 80;
  listen [::]:80;
  server_name ${PUBLIC_ADDRESS};
  location ^~ /.well-known/acme-challenge/ {
    root ${ACME_ROOT};
    default_type text/plain;
  }
  location / { return 404; }
}
NGINX
ln -sfn /etc/nginx/sites-available/fleetcomm-accounts /etc/nginx/sites-enabled/fleetcomm-accounts
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 64738/tcp
  ufw allow 64738/udp
fi

CERT_ARGS=(certonly --non-interactive --agree-tos --email "$LE_EMAIL" --webroot --webroot-path "$ACME_ROOT")
if (( PUBLIC_IS_IP )); then
  CERT_ARGS+=(--preferred-profile shortlived --ip-address "$PUBLIC_ADDRESS")
else
  CERT_ARGS+=(-d "$PUBLIC_ADDRESS")
fi
"$CERTBOT" "${CERT_ARGS[@]}"

cat > /etc/nginx/sites-available/fleetcomm-accounts << NGINX
server {
  listen 80;
  listen [::]:80;
  server_name ${PUBLIC_ADDRESS};
  location ^~ /.well-known/acme-challenge/ {
    root ${ACME_ROOT};
    default_type text/plain;
  }
  location / { return 301 https://${PUBLIC_ADDRESS}\$request_uri; }
}
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${PUBLIC_ADDRESS};
  ssl_certificate /etc/letsencrypt/live/${PUBLIC_ADDRESS}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${PUBLIC_ADDRESS}/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_tickets off;
  client_max_body_size 64k;
  add_header Referrer-Policy "no-referrer" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Strict-Transport-Security "max-age=31536000" always;
  location = /api/login {
    limit_req zone=fleetcomm_login burst=5 nodelay;
    proxy_pass http://127.0.0.1:8722;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
  location /api/ {
    proxy_pass http://127.0.0.1:8722;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
  location / { return 404; }
}
NGINX
nginx -t
systemctl reload nginx

# Reuse the public certificate for the Mumble TLS listener. The renewal hook
# copies key material with the narrow permissions mumble-server needs.
install -d -m 0750 -o root -g mumble-server /etc/mumble-server/fleetcomm-tls
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/fleetcomm-mumble.sh << HOOK
#!/usr/bin/env bash
set -e
install -m 0640 -o root -g mumble-server /etc/letsencrypt/live/${PUBLIC_ADDRESS}/fullchain.pem /etc/mumble-server/fleetcomm-tls/fullchain.pem
install -m 0640 -o root -g mumble-server /etc/letsencrypt/live/${PUBLIC_ADDRESS}/privkey.pem /etc/mumble-server/fleetcomm-tls/privkey.pem
systemctl restart mumble-server
systemctl reload nginx
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/fleetcomm-mumble.sh
/etc/letsencrypt/renewal-hooks/deploy/fleetcomm-mumble.sh

cat > /etc/systemd/system/fleetcomm-cert-renew.service << UNIT
[Unit]
Description=Renew FleetComm TLS certificate
[Service]
Type=oneshot
ExecStart=${CERTBOT} renew --quiet
UNIT
cat > /etc/systemd/system/fleetcomm-cert-renew.timer << UNIT
[Unit]
Description=Check FleetComm TLS certificate twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
UNIT

set_ini() {
  local key="$1" value="$2"
  if grep -q "^${key}=" /etc/mumble-server.ini; then
    sed -i "s|^${key}=.*|${key}=${value}|" /etc/mumble-server.ini
  else
    printf '%s=%s\n' "$key" "$value" >> /etc/mumble-server.ini
  fi
}
set_ini serverpassword "$RELAYPW"
set_ini sslCert /etc/mumble-server/fleetcomm-tls/fullchain.pem
set_ini sslKey /etc/mumble-server/fleetcomm-tls/privkey.pem
systemctl restart mumble-server
systemctl daemon-reload
systemctl enable --now fleetcomm-cert-renew.timer
systemctl enable --now fleetcomm-accounts

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw delete allow 8722/tcp >/dev/null 2>&1 || true
fi

rm -rf "$SECRETS_DIR"
curl --fail --silent --show-error "https://${PUBLIC_ADDRESS}/api/health"
echo
echo "FleetComm accounts and relay TLS are live at ${PUBLIC_ADDRESS}."
echo "Port 8722 is loopback-only. Claim COMMAND with the saved bootstrap code."
