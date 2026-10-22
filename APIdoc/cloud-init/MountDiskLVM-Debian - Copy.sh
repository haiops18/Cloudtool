sudo bash <<'BOOTSTRAP'
cat > /root/mount_disks_debian.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
shopt -s nullglob

ROWS='
vdb,/u01
vdc,/logs
'

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "ERROR: line=%s exit=%s\n" "$LINENO" "$?" >&2' ERR
tools=(pvcreate vgcreate lvcreate pvs vgs lvs parted partprobe udevadm mkfs.ext4 lsblk wipefs findmnt mountpoint blkid mount flock)
missing=false
for tool in "${tools[@]}"; do command -v "$tool" >/dev/null || missing=true; done
if [ "$missing" = true ]; then
    DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=180 -o Acquire::Retries=3 \
        install --no-install-recommends lvm2 parted e2fsprogs util-linux mount udev
    hash -r
fi
for tool in "${tools[@]}"; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
exec 9>/run/cloudtool-mount-disks.lock
flock -x 9

root_source=$(findmnt -n -o SOURCE /)
root_source=${root_source%%\[*}
root_disks=$(lsblk -srnpo NAME,TYPE "$root_source" | awk '$2=="disk" {print $1}')
[ -n "$root_disks" ] || fail 'Cannot identify root disks'
declare -a disks=() paths=() groups=()
declare -A seen_disks=() seen_paths=() seen_groups=()

while IFS=, read -r disk mp extra; do
    [ -n "$disk$mp$extra" ] || continue
    disk=${disk#/dev/}
    [[ "$disk" =~ ^[a-zA-Z0-9._-]+$ ]] || fail "Invalid disk: $disk"
    [[ "$mp" =~ ^/[a-zA-Z0-9_/-]+$ ]] && [ -z "$extra" ] || fail "Invalid mount path: $mp"
    [ "$(readlink -m -- "$mp")" = "$mp" ] || fail "Noncanonical or symlink mount path: $mp"
    case "$mp" in
        /|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/usr|/usr/*|/bin|/sbin|/lib|/lib64|/root|/var|/var/lib|/var/log|/opt|/home|/tmp)
            fail "System mount path: $mp" ;;
    esac
    dev=$(readlink -f -- "/dev/$disk")
    [ -b "$dev" ] && [ "$(lsblk -dnro TYPE "$dev")" = disk ] || fail "Not a disk: $dev"
    while read -r root_disk; do [ "$dev" != "$root_disk" ] || fail "Root disk: $dev"; done <<< "$root_disks"
    [ "$(lsblk -dnro RO "$dev")" = 0 ] || fail "Read-only disk: $dev"
    [ "$(lsblk -nrpo NAME "$dev" | wc -l)" -eq 1 ] || fail "Disk has partitions or consumers: $dev"
    [ -z "$(lsblk -nrpo MOUNTPOINT "$dev" | tr -d '[:space:]')" ] || fail "Disk in use: $dev"
    holders=(/sys/class/block/"${dev##*/}"/holders/*)
    [ "${#holders[@]}" -eq 0 ] || fail "Disk has holders: $dev"
    signatures=$(wipefs --no-act --noheadings --output TYPE "$dev")
    [ -z "$signatures" ] || fail "Disk contains data/signatures: $dev"
    mountpoint -q "$mp" && fail "Already mounted: $mp"
    [ ! -e "$mp" ] || { [ -d "$mp" ] && [ -z "$(find "$mp" -mindepth 1 -maxdepth 1 -print -quit)" ]; } || fail "Mount path is not an empty directory: $mp"
    if awk -v mp="$mp" '$1 !~ /^#/ && $2==mp {found=1} END {exit !found}' /etc/fstab; then fail "Existing fstab entry: $mp"; fi
    vg=${mp#/}; vg=${vg//\//_}; vg=${vg//-/_}
    [ "${#vg}" -le 120 ] || fail "VG name too long: $vg"
    if vgs "$vg" >/dev/null 2>&1; then fail "VG already exists: $vg"; fi
    [ -z "${seen_disks[$dev]:-}${seen_paths[$mp]:-}${seen_groups[$vg]:-}" ] || fail "Duplicate disk, mount path or VG: $dev $mp"
    for existing in "${paths[@]}"; do
        [[ "$mp/" != "$existing/"* && "$existing/" != "$mp/"* ]] || fail "Overlapping mount paths: $existing $mp"
    done
    seen_disks[$dev]=1; seen_paths[$mp]=1; seen_groups[$vg]=1
    disks+=("$dev"); paths+=("$mp"); groups+=("$vg")
done <<< "$ROWS"
[ "${#disks[@]}" -gt 0 ] || fail 'No disks configured'

backup=$(mktemp /etc/fstab.cloudtool.XXXXXX.bak)
cp -a /etc/fstab "$backup"
printf 'Fstab backup: %s\n' "$backup"
for i in "${!disks[@]}"; do
    dev=${disks[$i]}; mp=${paths[$i]}; vg=${groups[$i]}
    part="${dev}1"; [[ "$dev" != *[0-9] ]] || part="${dev}p1"
    printf '\n=== %s -> %s ===\n' "$dev" "$mp"
    parted -s -a optimal "$dev" mklabel gpt mkpart primary 1MiB 100% set 1 lvm on
    partprobe "$dev"
    udevadm settle --timeout=30
    for ((attempt=1; attempt<=30; attempt++)); do [ ! -b "$part" ] || break; sleep 1; done
    [ -b "$part" ] || fail "Partition not ready: $part"
    pvcreate "$part"
    vgcreate "$vg" "$part"
    lvcreate -l 100%FREE -n "$vg" "$vg"
    lvm="/dev/$vg/$vg"
    mkfs.ext4 "$lvm"
    uuid=$(blkid -s UUID -o value "$lvm")
    [ -n "$uuid" ] || fail "Missing filesystem UUID: $lvm"
    mkdir -p "$mp"
    printf 'UUID=%s %s ext4 defaults,nofail 0 2\n' "$uuid" "$mp" >> /etc/fstab
    systemctl daemon-reload
    mount "$mp"
    actual=$(findmnt -rn -M "$mp" -o UUID)
    [ "$actual" = "$uuid" ] || fail "Wrong filesystem mounted at $mp"
    printf 'OK: %s -> %s\n' "$lvm" "$mp"
done
lsblk -f
pvs
vgs
lvs
df -hT
EOF
chmod 0750 /root/mount_disks_debian.sh
/root/mount_disks_debian.sh
BOOTSTRAP
