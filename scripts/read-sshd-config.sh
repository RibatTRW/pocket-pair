#!/usr/bin/env bash
# Prints the SSH server's configuration as sshd reads it: sshd_config with every
# Include expanded in place, comments and blank lines dropped. No root needed
# (the files are world-readable on a normal install), and nothing is changed.
#
# Pocket Pair reads this only for the panel's passive state. Anything it cannot
# expand (an unreadable file, a quoted or too deeply nested Include) becomes a
# PocketPairUnresolved line, which Model.parseSshPolicy treats as "cannot prove
# key-only". The authoritative answer is `sudo sshd -T`, run in the terminal.
#
# POCKET_PAIR_SSH_DIR points it at another directory; tests use that instead of
# /etc/ssh.

export LC_ALL=C
root="${POCKET_PAIR_SSH_DIR:-/etc/ssh}"

unresolved() { echo "PocketPairUnresolved $1"; }

emit() {
  local file="$1" depth="$2" line rest word pattern path
  local -a words
  if [ ! -r "$file" ]; then
    unresolved unreadable
    return
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ ^[[:space:]]*[Ii][Nn][Cc][Ll][Uu][Dd][Ee]([[:space:]]+|[[:space:]]*=[[:space:]]*)(.*)$ ]]; then
      rest="${BASH_REMATCH[2]}"
      if (( depth >= 4 )); then unresolved depth; continue; fi
      case $rest in *'"'* | *"'"*) unresolved quoting; continue ;; esac
      read -ra words <<<"$rest"
      for word in "${words[@]}"; do
        [[ $word == \#* ]] && break
        case $word in /*) pattern="$word" ;; *) pattern="$root/$word" ;; esac
        # Unquoted on purpose: the pattern is a glob, expanded in sorted order.
        for path in $pattern; do
          [ -f "$path" ] || continue
          emit "$path" $((depth + 1))
        done
      done
    elif [[ ! $line =~ ^[[:space:]]*(#|$) ]]; then
      printf '%s\n' "$line"
    fi
  done <"$file"
}

emit "$root/sshd_config" 0
