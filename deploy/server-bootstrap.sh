#!/bin/bash
# Idempotent first-time setup of a fresh Ubuntu 24.04 LTS / Debian 12-13 server for the Docker stack. Run as root:
#   DEPLOY_PUBKEY="ssh-ed25519 AAAA... you@laptop" bash deploy/server-bootstrap.sh
# Does: OS updates + unattended security upgrades, swap (if none), deploy user with SSH key, firewall (SSH/80/443 only),
# fail2ban, Docker Engine + Compose plugin (Docker's apt repo), Docker log rotation, /srv/taskapp layout,
# hourly backup cron + logrotate. Safe to re-run.
# SSH hardening (no root login, no passwords) runs only with HARDEN_SSH=1 and only if the deploy user has a key:
# first confirm "ssh deploy@server" works in a second terminal, then re-run with HARDEN_SSH=1.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)"; exit 1; }
DEPLOY_USER=${DEPLOY_USER:-deploy}
SSH_PORT=${SSH_PORT:-22}
SWAP_SIZE=${SWAP_SIZE:-2G}
ROOT=/srv/taskapp
# shellcheck source=/dev/null
. /etc/os-release
export DEBIAN_FRONTEND=noninteractive
step() { echo "== $*"; }

step "OS updates and base packages"
apt-get update -q
apt-get -y -q upgrade
apt-get install -y -q ca-certificates curl gnupg git ufw fail2ban unattended-upgrades rsync restic
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

if [ -z "$(swapon --show)" ]; then
  step "swap file ($SWAP_SIZE)"
  fallocate -l "$SWAP_SIZE" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-taskapp.conf && sysctl -q -p /etc/sysctl.d/90-taskapp.conf
fi

if ! command -v docker >/dev/null; then
  step "Docker Engine + Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [ ! -f /etc/docker/daemon.json ]; then
  step "Docker daemon defaults (log rotation, live-restore)"
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "5" },\n  "live-restore": true\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

step "deploy user $DEPLOY_USER"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
KEYS=/home/$DEPLOY_USER/.ssh/authorized_keys
touch "$KEYS" && chown "$DEPLOY_USER:$DEPLOY_USER" "$KEYS" && chmod 600 "$KEYS"
if [ -n "${DEPLOY_PUBKEY:-}" ] && ! grep -qxF "$DEPLOY_PUBKEY" "$KEYS"; then echo "$DEPLOY_PUBKEY" >> "$KEYS"; fi

step "directories under $ROOT"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$ROOT" "$ROOT/backups" "$ROOT/logs"

step "firewall: SSH $SSH_PORT, HTTP 80, HTTPS 443 (tcp+udp) only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
# Note: Docker-published ports bypass ufw. The compose file publishes only Caddy's 80/443; never publish db or app ports.

step "fail2ban (sshd jail)"
printf '[sshd]\nenabled = true\nport = %s\nmaxretry = 5\nbantime = 1h\n' "$SSH_PORT" > /etc/fail2ban/jail.d/taskapp.local
systemctl enable --now fail2ban >/dev/null && systemctl restart fail2ban

step "hourly backup cron + logrotate"
printf 'SHELL=/bin/bash\n17 * * * * %s cd %s/app && BACKUP_DIR=%s/backups deploy/backup.sh >> %s/logs/backup.log 2>&1\n' \
  "$DEPLOY_USER" "$ROOT" "$ROOT" "$ROOT" > /etc/cron.d/taskapp-backup
printf '%s/logs/*.log {\n  weekly\n  rotate 8\n  compress\n  missingok\n  notifempty\n  copytruncate\n}\n' "$ROOT" > /etc/logrotate.d/taskapp

if [ "${HARDEN_SSH:-0}" = 1 ]; then
  if [ -s "$KEYS" ]; then
    step "SSH hardening: key-only, no root login"
    printf 'PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n' > /etc/ssh/sshd_config.d/10-taskapp.conf
    sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
  else
    echo "SKIPPED SSH hardening: $KEYS is empty (add a key and verify a login first)"
  fi
else
  echo "SSH hardening not applied yet: verify 'ssh $DEPLOY_USER@<server>' works, then re-run with HARDEN_SSH=1"
fi
step "done. Next: as $DEPLOY_USER, clone the repository into $ROOT/app (docs/deployment-audit/14_DEPLOYMENT_RUNBOOK.md)"
