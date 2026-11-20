#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 server. Run as root from the repo copy at /opt/deleverager:
#   cd /opt/deleverager && bash deploy/setup-vps.sh
# It installs Node, the bot's dependencies and the systemd service. It does NOT start the bot
# until /etc/deleverager.env has real values, and it never creates or handles keys itself.
set -euo pipefail

APP=/opt/deleverager
ENV_FILE=/etc/deleverager.env

if [ "$(id -u)" -ne 0 ]; then echo "run as root" >&2; exit 1; fi
if [ "$(pwd)" != "$APP" ]; then echo "run from $APP" >&2; exit 1; fi

apt-get update
apt-get install -y nodejs npm unattended-upgrades
node -e 'const [maj]=process.versions.node.split(".").map(Number); if (maj<18) { console.error("need Node 18+, have "+process.version); process.exit(1) }'

# Security updates install themselves; reboots are left to you.
dpkg-reconfigure -f noninteractive unattended-upgrades

id keeper >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin keeper
npm ci
chown -R root:root "$APP"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Fill these in, then: systemctl enable --now deleverager
DELEVERAGER_ADDRESS=
KEEPER_PRIVATE_KEY=
BASE_RPC=https://mainnet.base.org
NOTIFY_URL=
HEARTBEAT_URL=
EOF
fi
chown root:keeper "$ENV_FILE"
chmod 640 "$ENV_FILE"

cp deploy/deleverager.service /etc/systemd/system/deleverager.service
systemctl daemon-reload

if grep -qE '^(DELEVERAGER_ADDRESS|KEEPER_PRIVATE_KEY)=\s*$' "$ENV_FILE"; then
  echo
  echo "Installed. Not started: fill in $ENV_FILE, then run:"
  echo "  systemctl enable --now deleverager && journalctl -u deleverager -f"
else
  systemctl enable --now deleverager
  echo "Started. Logs: journalctl -u deleverager -f"
fi
