#!/usr/bin/env bash
set -Eeuo pipefail
# Install only the isolated standby. Never restart the main API or its workers.
if [[ $EUID -ne 0 || $# -ne 4 ]]; then
  echo 'Usage: sudo bash deploy/install-read-api.sh SERVICE_USER LIBRARY_ROOT PUBLIC_ORIGIN NGINX_SITE' >&2
  exit 1
fi
service_user=$1
library=$(realpath -e -- "$2")
public_origin=$3
site=$(realpath -e -- "$4")
source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
id "$service_user" >/dev/null
[[ $service_user =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ -d $library ]]
/usr/bin/node --input-type=module - "$library" "$public_origin" <<'JS'
const [library, origin] = process.argv.slice(2);
if (/[\s"\\%]/.test(library)) throw new Error('System service library path must not contain spaces, quotes, backslashes or %');
const url = new URL(origin);
if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('PUBLIC_ORIGIN must be a plain HTTP(S) origin');
JS
runuser -u "$service_user" -- test -r "$library"
runuser -u "$service_user" -- test -x "$library"
command -v curl >/dev/null
command -v nginx >/dev/null
nginx -t

release_root=/srv/niko-archive/services/wenku-read-api
revision=$(cd "$source" && sha256sum server/{app,read-api,library,text,captcha}.mjs shared/language.mjs | sha256sum | cut -c1-12)
release="$release_root/releases/$(date -u +%Y%m%dT%H%M%S)-$revision"
previous=$(readlink "$release_root/current" 2>/dev/null || true)
recovery=$(mktemp -d)
unit=/etc/systemd/system/niko-wenku-read-api.service
envfile=/etc/niko-wenku-read-api/server.env
[[ ! -f $unit ]] || cp -p "$unit" "$recovery/unit"
[[ ! -f $envfile ]] || cp -p "$envfile" "$recovery/env"
changed=false
rollback() {
  code=$?
  trap - ERR
  if $changed; then
    if [[ -f $recovery/unit ]]; then cp -p "$recovery/unit" "$unit"; else rm -f "$unit"; fi
    if [[ -f $recovery/env ]]; then cp -p "$recovery/env" "$envfile"; else rm -f "$envfile"; fi
    if [[ -n $previous ]]; then
      ln -sfn "$previous" "$release_root/current.recovery"
      mv -Tf "$release_root/current.recovery" "$release_root/current"
      systemctl daemon-reload
      systemctl restart niko-wenku-read-api.service || true
    else
      systemctl disable --now niko-wenku-read-api.service || true
      rm -f "$release_root/current"
      systemctl daemon-reload
    fi
  fi
  rm -rf -- "$recovery"
  echo 'Standby installation failed; primary API was not restarted.' >&2
  exit "$code"
}
trap rollback ERR

install -d -m 755 "$release/server" "$release/shared" /etc/niko-wenku-read-api
for name in app read-api library text captcha; do install -m 644 "$source/server/$name.mjs" "$release/server/"; done
install -m 644 "$source/shared/language.mjs" "$release/shared/"
install -d -m 700 -o "$service_user" -g "$(id -gn "$service_user")" /var/lib/niko-wenku-read-api
changed=true
printf 'ARCHIVE_READ_PORT=4179\nARCHIVE_LIBRARY=%s\nARCHIVE_READ_STATE_DIR=/var/lib/niko-wenku-read-api\nARCHIVE_PUBLIC_ORIGIN=%s\n' "$library" "$public_origin" > "$envfile"
chmod 600 "$envfile"
escaped_library=$(printf '%s' "$library" | sed 's/[&|]/\\&/g')
sed -e "s|@SERVICE_USER@|$service_user|g" -e "s|@LIBRARY_ROOT@|$escaped_library|g" "$source/deploy/niko-wenku-read-api.service" > "$unit"
chmod 644 "$unit"
ln -sfn "$release" "$release_root/current.new"
mv -Tf "$release_root/current.new" "$release_root/current"
systemctl daemon-reload
systemctl enable niko-wenku-read-api.service
systemctl restart niko-wenku-read-api.service
ready=false
for attempt in {1..90}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:4179/api/health > "$recovery/health"; then ready=true; break; fi
  sleep 1
done
$ready
cat "$recovery/health"
echo
/usr/bin/node "$source/deploy/configure-read-failover.mjs" "$site"
trap - ERR
rm -rf -- "$recovery"
echo "Read-only standby deployed: $release"
echo "Previous standby release: ${previous:-none}"
echo 'Primary API and scan/download workers were left running.'
