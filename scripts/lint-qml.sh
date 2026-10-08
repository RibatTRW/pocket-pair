#!/usr/bin/env bash
# Fail only on QML syntax errors. The files import Omarchy/Quickshell modules
# that do not exist on CI, so qmllint's other warnings (and its exit code) are
# environment noise, and its per-category flags differ between Qt versions.
QMLLINT="$(command -v qmllint || command -v qmllint6 || echo /usr/lib/qt6/bin/qmllint)"
out="$("$QMLLINT" "$@" 2>&1)"
if grep -F '[syntax]' <<<"$out"; then
  exit 1
fi
