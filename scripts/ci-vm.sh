#!/usr/bin/env bash
# Story 068, task 2.1 — every zeo-browser check, run from a fresh clone inside a disposable KVM
# guest: npm ci, format, lint, typecheck, unit, build and the Chrome e2e specs. The guest is a
# transient libvirt domain on qemu:///session (no root: the user is in `libvirt` and `kvm`), its
# disk a qcow2 overlay on a pinned Ubuntu cloud image, and it is destroyed on every exit path.
#
# Why a guest and not the working tree: a runner starts from a clean checkout, with no
# node_modules, no dist/ and no host cache. Testing here, the same way, is the evidence; GitHub
# only runs the small pull-request gate (.github/workflows/pr.yml).
#
# Usage: scripts/ci-vm.sh [--ref <rev>] [--logs <dir>] [--host-bin <path>] [--fetch]
#   --ref       commit to test (default HEAD); uncommitted changes are never tested
#   --logs      where the guest's logs land, one timestamped directory per run (default ci-vm-logs)
#   --host-bin  zeo-browser-host binary for the e2e specs (default $ZEO_BROWSER_HOST_BIN, then
#               /usr/libexec/zeo-browser-host)
#   --fetch     allow downloading the cloud image and Node tarball when they are not cached
set -euo pipefail

# Pinned 2026-11-04 from the publishers' own SHA256SUMS files.
readonly IMAGE_URL=https://cloud-images.ubuntu.com/releases/26.04/release-20261016/ubuntu-26.04-server-cloudimg-amd64.img
readonly IMAGE_SHA256=5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5
# Node matches package.json `engines.node` (>=24) and the version used on the development host.
readonly NODE_VERSION=v24.22.2
readonly NODE_URL=https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz
readonly NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
readonly LIBVIRT_URI=qemu:///session
readonly GUEST_MEMORY_MIB=8192
readonly GUEST_VCPUS=8
readonly GUEST_DISK=20G
readonly BOOT_TIMEOUT_S=600
readonly SUITE_TIMEOUT=45m

repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
ref=HEAD
logs_root=$repo/ci-vm-logs
host_bin=${ZEO_BROWSER_HOST_BIN:-/usr/libexec/zeo-browser-host}
fetch=0

log() { printf 'ci-vm: %s\n' "$*" >&2; }
die() {
  log "status=error $*"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
  --ref) ref=${2:?--ref needs a value} && shift 2 ;;
  --logs) logs_root=${2:?--logs needs a value} && shift 2 ;;
  --host-bin) host_bin=${2:?--host-bin needs a value} && shift 2 ;;
  --fetch) fetch=1 && shift ;;
  -h | --help) sed -n '2,/^set -euo/{/^#/s/^# \{0,1\}//p}' "$0" && exit 0 ;;
  *) die "reason=unknown-option option=$1" ;;
  esac
done

for bin in virsh qemu-img cloud-localds ssh ssh-keygen scp curl sha256sum git ss jq timeout; do
  command -v "$bin" >/dev/null || die "reason=missing-tool tool=$bin"
done
[[ -x $host_bin ]] || die "reason=missing-host-bin path=$host_bin"
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}") || die "reason=bad-ref ref=$ref"

cache=${XDG_CACHE_HOME:-$HOME/.cache}/zeo-browser-ci
mkdir -p "$cache"

# Downloads only with --fetch (the operator's yes), and verifies the cached copy on every run.
fetch_verified() {
  local url=$1 want=$2 dest=$3
  if [[ ! -f $dest ]]; then
    [[ $fetch -eq 1 ]] || die "reason=not-cached path=$dest hint=rerun-with---fetch"
    log "step=fetch url=$url"
    curl -fsSL --proto '=https' --tlsv1.2 -o "$dest.part" "$url" || die "reason=download-failed url=$url"
    mv "$dest.part" "$dest"
  fi
  printf '%s  %s\n' "$want" "$dest" | sha256sum -c --quiet - ||
    die "reason=checksum-mismatch path=$dest"
}

base_image=$cache/$(basename "$IMAGE_URL")
node_tarball=$cache/$(basename "$NODE_URL")
fetch_verified "$IMAGE_URL" "$IMAGE_SHA256" "$base_image"
fetch_verified "$NODE_URL" "$NODE_SHA256" "$node_tarball"

work=$(mktemp -d "$cache/run.XXXXXX")
domain=zeo-browser-ci-${work##*.}
started=0

# A transient domain (virsh create) leaves no definition behind once destroyed, and the overlay,
# seed and key all live in $work: removing both is the whole cleanup.
cleanup() {
  local rc=$?
  if [[ $started -eq 1 ]] && virsh -c "$LIBVIRT_URI" domstate "$domain" >/dev/null 2>&1; then
    virsh -c "$LIBVIRT_URI" destroy "$domain" >/dev/null 2>&1 || log "status=warn reason=destroy-failed domain=$domain"
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A free loopback port for the guest's sshd.
port=
for _ in $(seq 50); do
  candidate=$((20000 + RANDOM % 40000))
  if [[ -z $(ss -Hltn "sport = :$candidate") ]]; then
    port=$candidate
    break
  fi
done
[[ -n $port ]] || die "reason=no-free-port"

ssh-keygen -q -t ed25519 -N '' -C "$domain" -f "$work/id"
qemu-img create -q -f qcow2 -F qcow2 -b "$base_image" "$work/disk.qcow2" "$GUEST_DISK"

cat >"$work/user-data" <<EOF
#cloud-config
users:
  - name: ci
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$work/id.pub")
package_update: true
packages: [git, xvfb, xauth, xdotool, xz-utils, nftables]
EOF
printf 'instance-id: %s\nlocal-hostname: %s\n' "$domain" "$domain" >"$work/meta-data"
cloud-localds "$work/seed.img" "$work/user-data" "$work/meta-data"

# host-passthrough: the zeo-browser-host binary may be built for this CPU (AVX-512).
cat >"$work/domain.xml" <<EOF
<domain type='kvm'>
  <name>$domain</name>
  <memory unit='MiB'>$GUEST_MEMORY_MIB</memory>
  <vcpu>$GUEST_VCPUS</vcpu>
  <os><type arch='x86_64' machine='q35'>hvm</type></os>
  <features><acpi/></features>
  <cpu mode='host-passthrough'/>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='$work/disk.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='$work/seed.img'/>
      <target dev='sda' bus='sata'/>
      <readonly/>
    </disk>
    <interface type='user'>
      <backend type='passt'/>
      <model type='virtio'/>
      <portForward proto='tcp' address='127.0.0.1'>
        <range start='$port' to='22'/>
      </portForward>
    </interface>
    <serial type='file'>
      <source path='$work/console.log'/>
      <target port='0'/>
    </serial>
  </devices>
</domain>
EOF

log "step=boot domain=$domain port=$port ref=$sha"
# Set before create: an interrupt during create must still reach the destroy in cleanup, which
# checks domstate first.
started=1
virsh -c "$LIBVIRT_URI" create "$work/domain.xml" >/dev/null || die "reason=create-failed domain=$domain"

# The guest is ephemeral and only reachable on loopback, so its host key is not pinned.
ssh_opts=(-i "$work/id" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o BatchMode=yes -o ConnectTimeout=5
  -o ServerAliveInterval=15 -o ServerAliveCountMax=8)
guest() { ssh "${ssh_opts[@]}" -p "$port" ci@127.0.0.1 "$@"; }
to_guest() { scp "${ssh_opts[@]}" -P "$port" -q "$@"; }

deadline=$((SECONDS + BOOT_TIMEOUT_S))
until guest true 2>/dev/null; do
  [[ $SECONDS -lt $deadline ]] || die "reason=boot-timeout console=$work/console.log"
  virsh -c "$LIBVIRT_URI" domstate "$domain" >/dev/null 2>&1 || die "reason=guest-died domain=$domain"
  sleep 5
done
# cloud-init exits 2 when it finished with a recoverable error; the steps below are the judge.
cloud_rc=0
guest cloud-init status --wait >/dev/null || cloud_rc=$?
[[ $cloud_rc -eq 0 || $cloud_rc -eq 2 ]] || die "reason=cloud-init-failed exit=$cloud_rc"
log "step=provisioned cloud_init_exit=$cloud_rc seconds=$SECONDS"

# GIT_SSH_COMMAND is parsed by a shell, so each option is quoted on its own.
git_ssh="ssh$(printf ' %q' "${ssh_opts[@]}")"
guest 'git init -q --bare repo.git && mkdir -p bin logs' || die "reason=setup-failed step=init"
GIT_SSH_COMMAND=$git_ssh git -C "$repo" push -q "ssh://ci@127.0.0.1:$port/home/ci/repo.git" "$sha:refs/heads/ci" ||
  die "reason=setup-failed step=push"
guest 'git clone -q -b ci repo.git src' || die "reason=setup-failed step=clone"
to_guest "$node_tarball" "$repo/scripts/ci-guest.sh" ci@127.0.0.1:bin/ || die "reason=setup-failed step=copy"
to_guest "$host_bin" ci@127.0.0.1:bin/zeo-browser-host || die "reason=setup-failed step=copy-host-bin"
guest "sudo mkdir -p /opt/node && sudo tar -xJf bin/$(basename "$node_tarball") -C /opt/node --strip-components=1" ||
  die "reason=setup-failed step=node"

# passt maps the guest's default gateway onto the host's loopback, and libvirt exposes no switch
# to turn that off, so any dependency code run by the suite could reach every 127.0.0.1 service
# on this machine. Before any repository code runs, root in the guest drops new connections to
# the gateway except DNS, installs Chromium's system libraries, and then removes the ci user's
# sudo so nothing the suite runs can lift the rule.
# The rule is proved on a port that really listens on the host's loopback, probed before and after:
# reachable before shows the mapping exists, so unreachable after is the rule's doing.
probe_port=$(ss -Hltn 'src 127.0.0.1' | awk '{n=split($4,a,":"); print a[n]; exit}')
guest_reaches_host_loopback() {
  guest "gw=\$(ip -4 route show default | awk '{print \$3; exit}'); timeout 3 bash -c \"exec 3<>/dev/tcp/\$gw/$probe_port\"" 2>/dev/null
}
reachable_before=unprobed
if [[ -n $probe_port ]]; then
  reachable_before=no
  guest_reaches_host_loopback && reachable_before=yes
fi
playwright_version=$(git -C "$repo" show "$sha:package-lock.json" |
  jq -r '.packages["node_modules/playwright"].version // empty')
[[ -n $playwright_version ]] || die "reason=no-playwright-in-lock ref=$sha"
guest "sudo env PATH=/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin bash -s $(printf '%q' "$playwright_version")" <<'GUARD' ||
set -euo pipefail
# The address after `via`: an IPv6 default route learnt by RA puts other fields first.
via() { awk '{for (i = 1; i < NF; i++) if ($i == "via") { print $(i + 1); exit }}'; }
gw4=$(ip -4 route show default | via)
gw6=$(ip -6 route show default | via)
{
  echo 'table inet ci_guard {'
  echo '  chain out {'
  echo '    type filter hook output priority 0; policy accept;'
  echo '    ct state established,related accept'
  [[ -n $gw4 ]] && echo "    ip daddr $gw4 meta l4proto { tcp, udp } th dport 53 accept" && echo "    ip daddr $gw4 drop"
  [[ -n $gw6 ]] && echo "    ip6 daddr $gw6 meta l4proto { tcp, udp } th dport 53 accept" && echo "    ip6 daddr $gw6 drop"
  echo '  }'
  echo '}'
} | nft -f -
npx --yes "playwright@$1" install-deps chromium >/var/log/ci-playwright-deps.log 2>&1
rm -f /etc/sudoers.d/90-cloud-init-users
GUARD
  die "reason=setup-failed step=guard"
guest 'sudo -n true' 2>/dev/null && die "reason=setup-failed step=guard detail=sudo-still-allowed"

if [[ -n $probe_port ]]; then
  guest_reaches_host_loopback && die "reason=setup-failed step=guard detail=host-loopback-reachable port=$probe_port"
  log "step=guard host_loopback_port=$probe_port reachable_before=$reachable_before reachable_after=no"
else
  log "status=warn step=guard reason=no-host-loopback-listener-to-probe"
fi

suite_rc=0
guest "ZEO_BROWSER_HOST_BIN=/home/ci/bin/zeo-browser-host CI=1 timeout $SUITE_TIMEOUT bash bin/ci-guest.sh /home/ci/src /home/ci/logs" || suite_rc=$?

out=$logs_root/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}
mkdir -p "$out"
scp "${ssh_opts[@]}" -P "$port" -q -r 'ci@127.0.0.1:logs/.' "$out/" || log "status=warn reason=log-copy-failed"
cp "$work/console.log" "$out/console.log" 2>/dev/null || true

if [[ $suite_rc -ne 0 ]]; then
  failed=$(cat "$out/FAILED" 2>/dev/null || echo unknown)
  die "reason=step-failed step=$failed logs=$out"
fi
log "status=ok ref=$sha logs=$out seconds=$SECONDS"
