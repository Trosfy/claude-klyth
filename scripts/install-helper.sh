#!/bin/sh
set -eu
LC_ALL=C
export LC_ALL
umask 077

fail() {
  printf 'klyth install-helper: %s\n' "$1" >&2
  exit 1
}

ready() {
  printf '{"status":"%s"}\n' "$1"
  exit 0
}

[ "$#" -eq 4 ] || fail 'usage: install-helper.sh <url> <sha256> <size> <destination>'
url=$1
sha=$2
size=$3
destination=$4

case "$sha" in ''|*[!a-f0-9]*) fail 'invalid artifact digest' ;; esac
[ "${#sha}" -eq 64 ] || fail 'invalid artifact digest'
case "$size" in ''|0|0*|*[!0-9]*) fail 'invalid artifact size' ;; esac
[ "${#size}" -le 9 ] || fail 'invalid artifact size'
[ "$size" -le 268435456 ] || fail 'invalid artifact size'
[ "${#url}" -le 2048 ] || fail 'invalid artifact URL'
case "$url" in https://*) rest=${url#https://} ;; *) fail 'artifact URL must use HTTPS' ;; esac
case "$url" in *[!A-Za-z0-9:/._+-]*) fail 'invalid artifact URL' ;; esac
case "$rest" in */*) authority=${rest%%/*}; relative=${rest#*/} ;; *) fail 'invalid artifact URL' ;; esac
case "$authority" in ''|*:*:*) fail 'invalid artifact URL' ;; esac
host=${authority%%:*}
case "$host" in ''|*[!A-Za-z0-9.-]*|.*|*.|*..*) fail 'invalid artifact URL' ;; esac
case "$authority" in *:*) port=${authority#*:}; case "$port" in ''|*[!0-9]*) fail 'invalid artifact URL' ;; esac; [ "${#port}" -le 5 ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail 'invalid artifact URL' ;; esac
case "$relative" in ''|/*|*//*) fail 'invalid artifact URL' ;; esac
case "/$relative/" in */./*|*/../*) fail 'invalid artifact URL' ;; esac
case "$relative" in */klyth-*) asset=${relative##*/}; versionPath=${relative%/*}; version=${versionPath##*/} ;; *) fail 'artifact URL is not a versioned helper asset' ;; esac
case "$asset" in klyth-darwin-arm64|klyth-darwin-x64|klyth-linux-glibc-arm64|klyth-linux-glibc-x64) ;; *) fail 'unsupported artifact URL' ;; esac
printf '%s\n' "$version" | grep -Eq '^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' || fail 'artifact URL is not versioned'
lowerPath=$(printf '%s' "$relative" | tr '[:upper:]' '[:lower:]')
case "/$lowerPath/" in */latest/*) fail 'artifact URL must be immutable' ;; esac

home=${HOME-}
case "$home" in /*) ;; *) fail 'HOME must be a canonical absolute directory' ;; esac
if printf '%s' "$home" | grep -q '[[:cntrl:]]'; then fail 'HOME contains unsupported characters'; fi
[ "$home" != '/' ] || fail 'HOME must not be the filesystem root'
physicalHome=$(CDPATH= cd -P "$home" 2>/dev/null && pwd -P) || fail 'HOME is not a usable directory'
[ "$physicalHome" = "$home" ] || fail 'HOME must be canonical and must not be a symlink'
expected="$home/.local/share/klyth/helpers/$sha/klyth"
[ "$destination" = "$expected" ] || fail 'destination does not match the content-addressed helper path'

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v stat >/dev/null 2>&1 || fail 'stat is required'
command -v uname >/dev/null 2>&1 || fail 'uname is required'
command -v id >/dev/null 2>&1 || fail 'id is required'
command -v mktemp >/dev/null 2>&1 || fail 'mktemp is required'
command -v mkdir >/dev/null 2>&1 || fail 'mkdir is required'
command -v chmod >/dev/null 2>&1 || fail 'chmod is required'
command -v ln >/dev/null 2>&1 || fail 'ln is required'
command -v grep >/dev/null 2>&1 || fail 'grep is required'
command -v tr >/dev/null 2>&1 || fail 'tr is required'
command -v wc >/dev/null 2>&1 || fail 'wc is required'
command -v head >/dev/null 2>&1 || fail 'head is required'
if command -v shasum >/dev/null 2>&1; then
  hashTool=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  hashTool=sha256sum
else
  fail 'shasum or sha256sum is required'
fi

hostOs=$(uname -s) || fail 'could not identify the operating system'
hostArch=$(uname -m) || fail 'could not identify the CPU architecture'
case "$hostOs/$hostArch" in
  Darwin/arm64) expectedAsset=klyth-darwin-arm64 ;;
  Darwin/x86_64|Darwin/amd64) expectedAsset=klyth-darwin-x64 ;;
  Linux/aarch64|Linux/arm64)
    command -v getconf >/dev/null 2>&1 || fail 'cannot verify Linux libc; glibc is required'
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'cannot verify Linux libc; glibc is required'
    case "$libc" in 'glibc '*) expectedAsset=klyth-linux-glibc-arm64 ;; *) fail 'unsupported Linux libc; only verified glibc is supported' ;; esac
    ;;
  Linux/x86_64|Linux/amd64)
    command -v getconf >/dev/null 2>&1 || fail 'cannot verify Linux libc; glibc is required'
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'cannot verify Linux libc; glibc is required'
    case "$libc" in 'glibc '*) expectedAsset=klyth-linux-glibc-x64 ;; *) fail 'unsupported Linux libc; only verified glibc is supported' ;; esac
    ;;
  *) fail 'unsupported operating system or CPU architecture' ;;
esac
[ "$asset" = "$expectedAsset" ] || fail 'artifact does not match the native operating system and CPU'

uid=$(id -u) || fail 'could not identify the current user'
stat_values() {
  case $hostOs in
    Darwin) stat -f '%u %Lp' "$1" 2>/dev/null ;;
    Linux) stat -c '%u %a' -- "$1" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

check_directory() {
  path=$1
  private=$2
  [ ! -L "$path" ] || fail 'installation path contains a symbolic link'
  if [ ! -e "$path" ]; then
    mkdir -m 700 "$path" 2>/dev/null || [ -d "$path" ] || fail 'could not create installation directory'
  fi
  [ -d "$path" ] && [ ! -L "$path" ] || fail 'installation path is not a directory'
  values=$(stat_values "$path") || fail 'could not inspect installation directory'
  set -- $values
  owner=$1
  mode=$2
  [ "$owner" = "$uid" ] || fail 'installation directory has unexpected ownership'
  if [ "$private" = yes ]; then
    [ "$mode" = 700 ] || fail 'private installation directory must have mode 0700'
  else
    case "$mode" in [0-7][0-7][0-7]) ;; *) fail 'unsafe parent directory mode' ;; esac
    groupOther=${mode#?}
    case "$groupOther" in *[2367]*) fail 'unsafe writable parent directory' ;; esac
  fi
}

file_matches() {
  file=$1
  [ ! -L "$file" ] && [ -f "$file" ] || return 1
  values=$(stat_values "$file") || return 1
  set -- $values
  [ "$1" = "$uid" ] && [ "$2" = 700 ] || return 1
  actualSize=$(wc -c < "$file" | tr -d '[:space:]') || return 1
  [ "$actualSize" = "$size" ] || return 1
  if [ "$hashTool" = shasum ]; then
    hashResult=$(shasum -a 256 "$file" 2>/dev/null) || return 1
  else
    hashResult=$(sha256sum -- "$file" 2>/dev/null) || return 1
  fi
  actualHash=${hashResult%% *}
  [ "$actualHash" = "$sha" ]
}

check_directory "$home" no
check_directory "$home/.local" no
check_directory "$home/.local/share" no
check_directory "$home/.local/share/klyth" no
helpers="$home/.local/share/klyth/helpers"
check_directory "$helpers" yes
versionDirectory="$helpers/$sha"
if [ -e "$versionDirectory" ] || [ -L "$versionDirectory" ]; then
  check_directory "$versionDirectory" yes
else
  mkdir -m 700 "$versionDirectory" 2>/dev/null || [ -d "$versionDirectory" ] || fail 'could not create versioned helper directory'
  check_directory "$versionDirectory" yes
fi
if [ -e "$destination" ] || [ -L "$destination" ]; then
  file_matches "$destination" && ready already-ready
  fail 'existing content-addressed helper does not match the trusted artifact'
fi

stage=$(mktemp -d "$helpers/.stage.XXXXXXXX") || fail 'could not create private staging directory'
check_directory "$stage" yes
stagedBinary="$stage/klyth"
if ! curl -q --fail --location --max-redirs 3 --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --max-filesize "$size" --silent --show-error --output - "$url" 2>/dev/null | head -c "$((size + 1))" > "$stagedBinary"; then
  fail 'download failed; private staging data was retained'
fi
[ ! -L "$stagedBinary" ] && [ -f "$stagedBinary" ] || fail 'download did not produce a regular file'
actualSize=$(wc -c < "$stagedBinary" | tr -d '[:space:]') || fail 'could not measure downloaded helper'
[ "$actualSize" = "$size" ] || fail 'download size did not match the trusted artifact; private staging data was retained'
if [ "$hashTool" = shasum ]; then
  hashResult=$(shasum -a 256 "$stagedBinary" 2>/dev/null) || fail 'could not verify downloaded helper'
else
  hashResult=$(sha256sum -- "$stagedBinary" 2>/dev/null) || fail 'could not verify downloaded helper'
fi
actualHash=${hashResult%% *}
[ "$actualHash" = "$sha" ] || fail 'download digest did not match the trusted artifact; private staging data was retained'
chmod 700 "$stagedBinary" || fail 'could not set helper permissions'
file_matches "$stagedBinary" || fail 'staged helper failed ownership or permission validation'

if ln "$stagedBinary" "$versionDirectory/" 2>/dev/null; then
  file_matches "$destination" || fail 'published helper failed final verification'
  ready installed
fi
file_matches "$destination" && ready already-ready
fail 'another install created a different content-addressed helper; no file was replaced'
