sudo bash <<'BOOTSTRAP'
cat > /usr/local/sbin/cloudtool-install-teleport.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

REGION='public'
TOKEN='f7adb7ccdf04037bcd2b554hjn343lk52ec6010fd6f0caec94ba190b765'
SYSTEM='app'
TP_HOSTNAME="{{server.name.normalized}}"
PRIVATE_IP="{{server.private_ip[2]}}"
TP_MONITOR_IP="{{server.private_ip[1]}}"

: "${TOKEN:?Fill TOKEN before running}"
case "$REGION" in
  public) VERSION='13.4.14'; HOST_IP='10.129.0.232' ;;
  vpublic) VERSION='16.4.11'; HOST_IP='10.129.24.54' ;;
  *) exit 1 ;;
esac
HOST="$REGION.teleport.gpdn.net"
ARCH=$(dpkg --print-architecture)
PACKAGE=$(mktemp /tmp/teleport.XXXXXX.deb)
trap 'rm -f "$PACKAGE"' EXIT
URL="https://cdn.teleport.dev/teleport_${VERSION}_${ARCH}.deb"
if command -v curl >/dev/null; then
  curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$URL" -o "$PACKAGE"
elif command -v wget >/dev/null; then
  wget -q --tries=3 --timeout=30 -O "$PACKAGE" "$URL"
else
  printf '%s\n' 'VM needs curl or wget to download Teleport. Install either tool or repair the APT package indexes first.' >&2
  exit 1
fi
dpkg -i "$PACKAGE"
BINARY=$(command -v teleport)

sed -i -E '/(^|[[:space:]])(public|vpublic)\.teleport\.gpdn\.net([[:space:]]|$)/d; /^(10\.129\.0\.232|10\.129\.24\.54)[[:space:]]/d' /etc/hosts
printf '%s %s\n' "$HOST_IP" "$HOST" >> /etc/hosts
cat > /etc/systemd/system/teleport.service <<SERVICE
[Unit]
Description=Teleport node
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=$BINARY start --pid-file=/run/teleport.pid --roles=node --token=$TOKEN --auth-server=$HOST:443 --nodename=${SYSTEM}_${TP_HOSTNAME}_${TP_MONITOR_IP} --labels=env=pro,system=$SYSTEM,type=server,ip_local=$PRIVATE_IP,ip=$TP_MONITOR_IP
Restart=always
RestartSec=5
KillMode=process
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable teleport
systemctl restart teleport
systemctl is-active --quiet teleport
EOF
chmod 0750 /usr/local/sbin/cloudtool-install-teleport.sh
/usr/local/sbin/cloudtool-install-teleport.sh
BOOTSTRAP
