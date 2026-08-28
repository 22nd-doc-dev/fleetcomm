#!/usr/bin/env bash
# FleetComm server bootstrap — run as root on a fresh Ubuntu 22.04/24.04 VPS (a $5 box is plenty for 60+ operators).
#   curl -fsSL <raw-url>/setup.sh | bash -s -- 'YourSuperUserPassword'
# or: bash setup.sh 'YourSuperUserPassword'
set -euo pipefail
SUPW="${1:?usage: setup.sh <SuperUser-password>}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq mumble-server

cat > /etc/mumble-server.ini << INI
database=/var/lib/mumble-server/mumble-server.sqlite
ice="tcp -h 127.0.0.1 -p 6502"
welcometext=<b>22nd Expeditionary Fleet</b> — FleetComm relay. Unauthorized access is monitored.
port=64738
users=600
bandwidth=144000
opusthreshold=0
messagelimit=10
messageburst=50
allowping=true
timeout=30
autobanAttempts=100
autobanTimeframe=60
autobanTime=60
logfile=/var/log/mumble-server/mumble-server.log
uname=mumble-server
INI

# set SuperUser password (service must be stopped)
systemctl stop mumble-server || true
su -s /bin/sh mumble-server -c "mumble-server -ini /etc/mumble-server.ini -supw '$SUPW'" 2>/dev/null \
  || mumble-server -ini /etc/mumble-server.ini -supw "$SUPW"
systemctl enable --now mumble-server

# firewall (if ufw is active)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 64738/tcp; ufw allow 64738/udp
fi

echo
echo "══════════════════════════════════════════════════════"
echo " FleetComm relay is up on port 64738."
echo " Next, from your own machine, seed the 22nd channel tree:"
echo "   npm run seed -- <this-server-ip-or-domain> '$SUPW'"
echo "══════════════════════════════════════════════════════"
