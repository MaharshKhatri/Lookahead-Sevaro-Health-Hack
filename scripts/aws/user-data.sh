#!/bin/bash
# Lookahead on Amazon Linux 2023 (x86_64 or arm64): EC2 user data.
#
# Launch with `aws ec2 run-instances ... --user-data file://user-data.sh`
# (scripts/aws/deploy-ec2.md), or re-run on the instance to redeploy.
# AWS credentials come ONLY from the instance profile: nothing secret is in
# this file. OFFER_LINK_SECRET is generated on the instance and kept across
# redeploys in /etc/lookahead.env.
#
# Result: Next.js production server on port 80 under systemd (unit
# "lookahead"), live logs in /var/lib/lookahead/live, setup log in
# /var/log/lookahead-setup.log.
set -euo pipefail
export HOME="${HOME:-/root}"
exec > >(tee -a /var/log/lookahead-setup.log) 2>&1
echo "=== lookahead setup $(date -u +%FT%TZ) ==="

# ------------------------------- CONFIG -------------------------------------
# Where the code comes from (the GitHub repo is private, so EC2 cannot clone it):
#   s3://BUCKET/code/lookahead.tgz     needs the instance profile (s3:GetObject, iam-policy.json)
#   https://...                        an `aws s3 presign` URL: needs no instance profile
#   https://github.com/OWNER/REPO.git  only if the repository is public
#   /home/ec2-user/lookahead.tgz       a tarball copied over with scp
CODE_SOURCE="s3://CHANGE-ME/code/lookahead.tgz"
GIT_BRANCH="claude/lookahead-bootstrap-data-lk91zn"
STORE="dynamo"
TABLE_NAME="lookahead-log"
AWS_REGION="us-east-1"
BEDROCK_MODEL_ID=""
NARRATION="on"
LEAD_PIN="2026"
AUDIT_BUCKET=""
PUBLIC_ORIGIN=""
NODE_MAJOR="20"
PNPM_VERSION="10.28.0"
# STORE:            dynamo | file (file = no DynamoDB needed; the demo is identical)
# BEDROCK_MODEL_ID: empty = discover (Claude Haiku preferred, else Sonnet)
# NARRATION:        off = template text only, never calls Bedrock
# AUDIT_BUCKET:     optional; archive audit CSV + action log to S3 on reset/swap
# PUBLIC_ORIGIN:    empty = http://<this instance's public DNS> (QR codes, offer links)
# ----------------------------------------------------------------------------

APP_USER=lookahead
NODE_DIR=/opt/node
RELEASES=/opt/lookahead-releases
CURRENT=/opt/lookahead
LIVE_DIR=/var/lib/lookahead/live
ENV_FILE=/etc/lookahead.env

# --- instance metadata (IMDSv2) ---
IMDS_TOKEN=$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)
imds() { curl -sS -f -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true; }
PUBLIC_HOST=$(imds public-hostname)
[ -n "$PUBLIC_HOST" ] || PUBLIC_HOST=$(imds public-ipv4)
[ -n "$PUBLIC_ORIGIN" ] || PUBLIC_ORIGIN="http://${PUBLIC_HOST:-localhost}"
echo "public origin: $PUBLIC_ORIGIN"

# --- swap: `next build` needs ~2 GB; small instances get a 2 GB swap file ---
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 3500 ] && ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
  echo "swap: 2 GB added (memory ${MEM_MB} MB)"
fi

# --- packages + Node.js (official tarball, checksum verified) + pnpm ---
dnf install -y -q git tar xz
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$BASE/SHASUMS256.txt" -o /tmp/node-SHASUMS256.txt
  NODE_FILE=$(grep -E " node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz$" /tmp/node-SHASUMS256.txt | awk '{print $2}')
  curl -fsSL "$BASE/$NODE_FILE" -o "/tmp/$NODE_FILE"
  (cd /tmp && grep " $NODE_FILE\$" node-SHASUMS256.txt | sha256sum -c -)
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "/tmp/$NODE_FILE" -C "$NODE_DIR" --strip-components=1
fi
export PATH="$NODE_DIR/bin:$PATH"
npm install -g --silent "pnpm@$PNPM_VERSION"
echo "node $(node -v), pnpm $(pnpm -v)"

# --- app user and directories ---
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir /var/lib/lookahead --create-home --shell /sbin/nologin "$APP_USER"
mkdir -p "$LIVE_DIR" "$RELEASES"
chown -R "$APP_USER:$APP_USER" /var/lib/lookahead

# --- fetch the code into a new release directory ---
RELEASE="$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RELEASE"
case "$CODE_SOURCE" in
  s3://*) aws s3 cp --only-show-errors --region "$AWS_REGION" "$CODE_SOURCE" /tmp/lookahead.tgz && tar -xzf /tmp/lookahead.tgz -C "$RELEASE" ;;
  *.git) git clone --quiet --depth 1 --branch "$GIT_BRANCH" "$CODE_SOURCE" "$RELEASE" ;;
  http://* | https://*) curl -fsSL "$CODE_SOURCE" -o /tmp/lookahead.tgz && tar -xzf /tmp/lookahead.tgz -C "$RELEASE" ;;
  *) tar -xzf "$CODE_SOURCE" -C "$RELEASE" ;;
esac
# Accept tarballs with or without a top-level folder.
WORKSPACE_FILE=$(find "$RELEASE" -maxdepth 2 -name pnpm-workspace.yaml | head -1)
[ -n "$WORKSPACE_FILE" ] || { echo "no pnpm-workspace.yaml in $CODE_SOURCE"; exit 1; }
SRC=$(dirname "$WORKSPACE_FILE")
echo "code: $CODE_SOURCE -> $SRC"

# --- install and build ---
cd "$SRC"
export CI=1 NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
pnpm install --frozen-lockfile --reporter=append-only
pnpm --filter web build
chown -R "$APP_USER:$APP_USER" "$RELEASE"

# --- runtime configuration (no AWS keys: the SDK uses the instance profile) ---
SECRET=""
[ -f "$ENV_FILE" ] && SECRET=$(grep -E '^OFFER_LINK_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)
[ -n "$SECRET" ] || SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
umask 077
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
STORE=$STORE
TABLE_NAME=$TABLE_NAME
AWS_REGION=$AWS_REGION
BEDROCK_MODEL_ID=$BEDROCK_MODEL_ID
NARRATION=$NARRATION
LEAD_PIN=$LEAD_PIN
OFFER_LINK_SECRET=$SECRET
AUDIT_BUCKET=$AUDIT_BUCKET
LOOKAHEAD_PUBLIC_ORIGIN=$PUBLIC_ORIGIN
LOOKAHEAD_LIVE_DIR=$LIVE_DIR
EOF
umask 022

cat > /etc/systemd/system/lookahead.service <<EOF
[Unit]
Description=Lookahead command center (next start on :80)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$CURRENT/apps/web
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$CURRENT/apps/web/node_modules/.bin/next start -p 80 -H 0.0.0.0
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# --- switch to the new release, keep the previous one for rollback ---
ln -sfn "$SRC" "$CURRENT"
systemctl daemon-reload
systemctl enable lookahead >/dev/null
systemctl restart lookahead
ls -1dt "$RELEASES"/* | tail -n +3 | xargs -r rm -rf

for _ in $(seq 1 60); do
  if curl -fsS -m 5 http://127.0.0.1/api/health -o /tmp/lookahead-health.json; then
    echo "healthy: $(cat /tmp/lookahead-health.json)"
    echo "=== open $PUBLIC_ORIGIN/ ==="
    exit 0
  fi
  sleep 2
done
echo "lookahead did not become healthy; last service log:"
journalctl -u lookahead -n 60 --no-pager
exit 1
