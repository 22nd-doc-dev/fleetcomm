#!/usr/bin/env bash
# FleetComm server bootstrap — run as root on a fresh Ubuntu 22.04/24.04 VPS (a $5 box is plenty for 60+ operators).
# Run interactively so the SuperUser password is not persisted in shell history
# or written to disk; it is used only by the short-lived password setup command.
#   sudo bash setup.sh
set -euo pipefail
read -r -s -p "New Mumble SuperUser password: " SUPW
echo
test -n "$SUPW" || { echo "password is required" >&2; exit 1; }

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
command -v runuser >/dev/null || { echo "runuser is required to set the SuperUser password safely" >&2; exit 1; }
runuser -u mumble-server -- mumble-server -ini /etc/mumble-server.ini -supw "$SUPW"
unset SUPW
systemctl enable --now mumble-server

# firewall (if ufw is active)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 64738/tcp; ufw allow 64738/udp
fi

echo
echo "══════════════════════════════════════════════════════"
echo " FleetComm relay is up on port 64738."
echo " Next, seed the 22nd channel tree from your workstation."
echo " Then configure DNS and run server/deploy.sh from the repository."
echo "══════════════════════════════════════════════════════"
