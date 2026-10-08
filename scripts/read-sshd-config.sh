#!/usr/bin/env bash
# Prints the SSH server's configuration as sshd reads it: sshd_config with every
# Include expanded in place, comments and blank lines dropped. No root needed
# (the files are world-readable on a normal install), and nothing is changed.
#
# Pocket Pair reads this only for the panel's passive state. Anything it cannot
# expand (an unreadable file, an Include that points into a directory this user
# cannot look inside, a quoted or too deeply nested Include) becomes a
# `PocketPairUnresolved <reason> <path>` line, which Model.parseSshPolicy treats
# as "cannot prove key-only", and the fix step then stops instead of starting
# or reloading sshd. Each Match line is followed by `PocketPairAt <file>` so the
# panel can name the file to review. The authoritative answer is `sudo sshd -T`
# plus a root scan of every included file, both run in the terminal.
#
# POCKET_PAIR_SSH_DIR points it at another directory; tests use that instead of
# /etc/ssh.

export LC_ALL=C
root="${POCKET_PAIR_SSH_DIR:-/etc/ssh}"

unresolved() { echo "PocketPairUnresolved $1 $2"; }

# Whether an Include pattern that matched no file is really empty, rather than
# pointing somewhere this user cannot look. True only when the directory it
# names (or its nearest existing parent) can be listed and entered.
nothing_hidden() {
  local dir="${1%/*}"
  case $dir in *[\*\?\[]*) return 1 ;; esac
  until [ -d "$dir" ]; do
    dir="${dir%/*}"
    [ -n "$dir" ] || dir=/
  done
  [ -r "$dir" ] && [ -x "$dir" ]
}

emit() {
  local file="$1" depth="$2" line rest word pattern path found
  local -a words
  if [ ! -r "$file" ]; then
    unresolved unreadable "$file"
    return
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line =~ ^[[:space:]]*[Ii][Nn][Cc][Ll][Uu][Dd][Ee]([[:space:]]+|[[:space:]]*=[[:space:]]*)(.*)$ ]]; then
      rest="${BASH_REMATCH[2]}"
      if (( depth >= 4 )); then unresolved depth "$file"; continue; fi
      case $rest in *'"'* | *"'"*) unresolved quoting "$file"; continue ;; esac
      read -ra words <<<"$rest"
      for word in "${words[@]}"; do
        [[ $word == \#* ]] && break
        case $word in /*) pattern="$word" ;; *) pattern="$root/$word" ;; esac
        # Unquoted on purpose: the pattern is a glob, expanded in sorted order.
        found=0
        for path in $pattern; do
          [ -e "$path" ] && found=1
          [ -f "$path" ] || continue
          emit "$path" $((depth + 1))
        done
        if (( ! found )) && ! nothing_hidden "$pattern"; then unresolved hidden "$pattern"; fi
      done
    elif [[ ! $line =~ ^[[:space:]]*(#|$) ]]; then
      printf '%s\n' "$line"
      if [[ $line =~ ^[[:space:]]*[Mm][Aa][Tt][Cc][Hh]([[:space:]]|=|$) ]]; then echo "PocketPairAt $file"; fi
    fi
  done <"$file"
}

emit "$root/sshd_config" 0
