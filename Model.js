// Pure helpers for Pocket Pair: parsing what the machine tells us, deciding the
// next step, and shaping the few strings the shell hands to other programs.
// Nothing here touches the shell, a process or the clock, so node can test it.
//
// The pairing link that `moshi-hook host setup --json` prints is an access
// token. Nothing in this file stores, logs or returns it except
// parseSetupLine, whose caller hands it straight to qrencode.

var GLYPHS = {
  phone: "",
  ok: "●",
  todo: "○",
  wait: "◌"
}

var PAIR_SECONDS = 300
var CHECK_KEYS = ["hook_path", "hook_version", "daemon", "mosh", "sshd", "ts_status", "ts_prefs"]

// "moshi-hook version 0.4.15", "v0.4.20" and "0.4.20\n" all mean a version.
function parseVersion(text) {
  var match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""))
  return match ? match[1] + "." + match[2] + "." + match[3] : ""
}

// -1, 0 or 1; an unparseable side compares equal so a failed lookup never
// nags the user to update.
function compareVersions(a, b) {
  var left = parseVersion(a).split(".")
  var right = parseVersion(b).split(".")
  if (left[0] === "" || right[0] === "") return 0
  for (var i = 0; i < 3; i++) {
    var x = parseInt(left[i], 10)
    var y = parseInt(right[i], 10)
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// The check script prints one `key=value` per line. Unknown keys are dropped
// so a stray line from a profile script cannot leak into the model.
function parseCheckOutput(text) {
  var raw = {}
  String(text || "").split(/\r?\n/).forEach(function(line) {
    var at = line.indexOf("=")
    if (at <= 0) return
    var key = line.slice(0, at)
    if (CHECK_KEYS.indexOf(key) >= 0) raw[key] = line.slice(at + 1).trim()
  })
  return raw
}

function parseJson(text) {
  try { return JSON.parse(String(text || "")) } catch (e) { return null }
}

// ssh is null when the prefs could not be read; the pairing step then lets
// moshi-hook's own prerequisite check have the final word.
function parseTailscale(statusText, prefsText) {
  var status = parseJson(statusText)
  var prefs = parseJson(prefsText)
  var result = { state: "missing", ip: "", ssh: null }
  if (!status) return result
  var backend = String(status.BackendState || "")
  result.state = backend === "Running" ? "running" : "down"
  var ips = status.Self && status.Self.TailscaleIPs ? status.Self.TailscaleIPs : status.TailscaleIPs || []
  for (var i = 0; i < ips.length; i++) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ips[i])) { result.ip = ips[i]; break }
  }
  if (result.state === "running" && result.ip === "") result.state = "down"
  if (prefs && typeof prefs.RunSSH === "boolean") result.ssh = prefs.RunSSH
  return result
}

function buildChecks(raw, latestText) {
  raw = raw || {}
  var version = parseVersion(raw.hook_version)
  var latest = parseVersion(latestText)
  var present = !!raw.hook_path && version !== ""
  return {
    hook: {
      present: present,
      path: present ? raw.hook_path : "",
      version: version,
      latest: latest,
      outdated: present && compareVersions(version, latest) < 0
    },
    daemon: raw.daemon === "active",
    mosh: raw.mosh === "yes",
    sshd: raw.sshd === "active",
    tailscale: parseTailscale(raw.ts_status, raw.ts_prefs)
  }
}

// The three commands that need root, in the order a first pairing needs them.
// Fixed strings: the terminal shows these exact words and nothing is built
// from machine output.
var FIXES = {
  mosh: { cmd: "sudo pacman -S mosh", why: "mosh-server, so the phone can use Mosh" },
  sshd: { cmd: "sudo systemctl enable --now sshd", why: "the SSH server Moshi connects to" },
  tsssh: { cmd: "sudo tailscale set --ssh=false", why: "so port 22 reaches sshd, not Tailscale" }
}

function pendingFixes(checks) {
  var list = []
  if (!checks.mosh) list.push({ id: "mosh", cmd: FIXES.mosh.cmd, why: FIXES.mosh.why })
  if (!checks.sshd) list.push({ id: "sshd", cmd: FIXES.sshd.cmd, why: FIXES.sshd.why })
  if (checks.tailscale.ssh === true) list.push({ id: "tsssh", cmd: FIXES.tsssh.cmd, why: FIXES.tsssh.why })
  return list
}

// The checklist the panel shows while something is still missing.
function checklist(checks) {
  var ts = checks.tailscale
  var tsDetail = ts.state === "running" ? ts.ip
    : ts.state === "missing" ? "not installed" : "not connected"
  return [
    {
      id: "hook", label: "moshi-hook",
      state: checks.hook.present ? "ok" : "todo",
      detail: checks.hook.present ? checks.hook.version : "not installed"
    },
    {
      id: "tailscale", label: "Tailscale",
      state: ts.state === "running" ? "ok" : "wait",
      detail: tsDetail
    },
    {
      id: "mosh", label: "mosh-server",
      state: checks.mosh ? "ok" : "todo",
      detail: checks.mosh ? "installed" : "missing"
    },
    {
      id: "sshd", label: "SSH server",
      state: checks.sshd ? "ok" : "todo",
      detail: checks.sshd ? "running" : "not running"
    },
    {
      id: "tsssh", label: "Tailscale SSH",
      state: ts.ssh === true ? "todo" : "ok",
      detail: ts.ssh === true ? "on" : "off"
    }
  ]
}

// One primary action at a time. kind: install, fix, wait, pair, done.
function nextStep(checks, hosts) {
  if (!checks.hook.present) return { kind: "install", label: "Install helper" }
  if (checks.tailscale.state !== "running") {
    return {
      kind: "wait", label: "Check again",
      hint: checks.tailscale.state === "missing"
        ? "Pocket Pair pairs over Tailscale. Install Tailscale and sign in; this continues by itself."
        : "Tailscale is not connected. Connect it and this continues by itself."
    }
  }
  var fixes = pendingFixes(checks)
  if (fixes.length > 0) {
    return { kind: "fix", label: fixes.length === 1 ? "Fix in a terminal" : "Set up in a terminal", fixes: fixes }
  }
  if (hosts && hosts.length > 0) return { kind: "done", label: "Pair another phone" }
  return { kind: "pair", label: "Show QR" }
}

// A one-line script for the floating terminal: it prints every command before
// running any of them, then stops at the first failure.
function fixScript(fixes) {
  var parts = ["echo 'Pocket Pair will run:'"]
  fixes.forEach(function(fix) { parts.push("echo '  $ " + fix.cmd + "'") })
  parts.push("echo")
  parts.push(fixes.map(function(fix) { return fix.cmd }).join(" && "))
  return parts.join("; ")
}

// `moshi-hook host list`: id, user@host:port, SHA256 fingerprint, status,
// separated by runs of spaces.
function parseHostList(text) {
  var hosts = []
  String(text || "").split(/\r?\n/).forEach(function(line) {
    var cols = line.trim().split(/\s+/)
    if (cols.length < 3 || !isHostId(cols[0])) return
    hosts.push({ id: cols[0], target: cols[1], fingerprint: cols[2], status: cols[3] || "" })
  })
  return hosts
}

// Ids go to `host revoke` as an argv element, never through a shell, but an
// odd id is still not worth passing on.
function isHostId(id) {
  return /^host_[A-Za-z0-9_+\/=.:-]{1,200}$/.test(String(id || ""))
}

// One JSON object per line from `host setup --json`.
function parseSetupLine(line) {
  var data = parseJson(String(line || "").trim())
  if (!data || typeof data !== "object") return null
  return {
    status: String(data.status || ""),
    deepLink: typeof data.deepLink === "string" ? data.deepLink : "",
    error: typeof data.error === "string" ? data.error : ""
  }
}

// qrencode -t ASCII draws every module as two characters ("##" dark, spaces
// light) and every row as one line. A malformed matrix returns empty rather
// than a code that cannot scan.
function parseQrAscii(text) {
  var lines = String(text || "").split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return { rows: [], size: 0 }
  var rows = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.length === 0 || line.length % 2 !== 0 || !/^[# ]+$/.test(line)) return { rows: [], size: 0 }
    var row = ""
    for (var j = 0; j < line.length; j += 2) row += line.substr(j, 2) === "##" ? "1" : "0"
    rows.push(row)
  }
  var size = rows[0].length
  if (rows.length !== size) return { rows: [], size: 0 }
  for (var k = 0; k < rows.length; k++) if (rows[k].length !== size) return { rows: [], size: 0 }
  return { rows: rows, size: size }
}

function formatCountdown(seconds) {
  var s = Math.max(0, Math.floor(seconds))
  var m = Math.floor(s / 60)
  var rest = s % 60
  return m + ":" + (rest < 10 ? "0" : "") + rest
}

// Error text can come from a child process; keep it short, one line, and free
// of any link that could be a pairing token.
function scrub(text) {
  var lines = String(text || "").split(/\r?\n/).filter(function(l) { return l.trim() !== "" })
  var line = lines.slice(0, 2).join(" ")
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[link hidden]").trim().slice(0, 160)
}

if (typeof module !== "undefined") {
  module.exports = {
    GLYPHS: GLYPHS, PAIR_SECONDS: PAIR_SECONDS, FIXES: FIXES,
    parseVersion: parseVersion, compareVersions: compareVersions,
    parseCheckOutput: parseCheckOutput, parseTailscale: parseTailscale,
    buildChecks: buildChecks, pendingFixes: pendingFixes, checklist: checklist,
    nextStep: nextStep, fixScript: fixScript, parseHostList: parseHostList,
    isHostId: isHostId, parseSetupLine: parseSetupLine, parseQrAscii: parseQrAscii,
    formatCountdown: formatCountdown, scrub: scrub
  }
}
