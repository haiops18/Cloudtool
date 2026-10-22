# Debian 13 cloud-init

Use `debian13-cloudtool-static-teleport.yaml` as the complete template. It keeps native ifupdown (`/etc/network/interfaces`) used by the original working Debian image; no Netplan or Python helper is installed.

## Networking

- Without Elastic: local NIC owns the default route and DNS.
- With Elastic: Elastic owns the only default route/DNS; local routes `vpc_cidr` via `local_gateway`.
- Monitor: static DHCP address/prefix, without a gateway or DNS.
- NICs are identified by actual IPv4 addresses, not eth0/eth1 ordering. Missing/ambiguous NICs or Elastic gateway cause a bounded wait and an error rather than a guessed configuration.
- Config is parsed before applying. DHCP is stopped through the old ifupdown configuration, then the static configuration is applied and verified. Failure restores the original interfaces file and restarts networking. Existing interfaces.d fragments are retained but no longer sourced by the managed main file.
- If networking.service restarts without applying the expected NIC addresses/routes, the script explicitly runs ifdown/ifup --force for each managed NIC and verifies again. Missing addresses and route mismatches, plus actual address/route snapshots, are logged before rollback.

## Teleport options

The script uses `TELEPORT_ENABLE` and `TP_REGION` (`public` / `vpublic`) like the Ubuntu example, including the `ip_local` label. The original join token is retained in the editable script. The generated token environment file is root-only; the service unit does not embed the token.

Only `public` and `vpublic` are accepted; other values fail explicitly. Both use normal certificate verification. Version, endpoint and host alias are grouped in each profile for editing.

Re-running the script preserves `/var/lib/teleport` and the node identity.

## Data volumes

Before scanning disks, the mount script sets a system PATH including sbin, checks all required volume tools, and installs lvm2/e2fsprogs/util-linux/mount if necessary (noninteractive APT, with lock timeout and download retries). These volume packages are installed only by the mount script, not by cloud-init's global packages stage. It rechecks the tools before proceeding; installation errors stop the mount step before any disk mutation. An empty data-volume list skips installation.

The mount script does not run apt-get update. It only downloads and installs the required volume packages using existing package indexes. Repository files and signature verification remain unchanged. Failed installation or missing tools still stop the script before disk changes.

`data_volumes_shell` supplies rows `data,type,size_GB,/mount_path`. Only data rows are used. A blank, writable, non-root disk of the requested size is used directly as an LVM PV and formatted ext4. Equivalent same-size blank disks are selected by device-name order, since these rows do not include cloud volume device IDs.

VG/LV names follow the mount path, e.g. `/data` becomes VG `data`, LV `data`. New objects receive a `cloudtool` LVM tag. Direct disk PVs avoid the GPT/partition-readiness steps; existing tagged VGs using partition PVs are still reusable. A rerun reuses tagged ext4 LVs without formatting; unrelated VGs, other filesystems, root-backed volumes and occupied directories are rejected. UUID entries are written to fstab for reboot stability without duplicating mount entries.

Existing untagged Ubuntu VGs are not automatically adopted or reformatted.

## Execution and logs

Separate runcmd entries follow the Ubuntu sample exactly for hostname, static IP and Teleport, with a matching entry for volume mount. They execute all four steps independently: hostname, static IP (after the original 30-second delay), Teleport, volume mount. A failure is recorded without skipping the other steps.

- `/var/log/cloudtool/bootstrap.log`
- `/var/log/cloudtool/hostname.log`
- `/var/log/cloudtool/static-ip.log`
- `/var/log/cloudtool/teleport.log`
- `/var/log/cloudtool/mount-volumes.log`
- Backups: `/var/backups/cloudtool/networking/` and `/var/backups/cloudtool/volumes/`

Validated with sandboxed Bash tests and the CloudTool variable renderer; not yet verified on a live Debian 13 VM.
