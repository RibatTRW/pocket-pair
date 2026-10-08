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
var CHECK_KEYS = ["hook_path", "hook_version", "daemon", "mosh", "sshd", "ts_bin", "ts_status", "ts_prefs",
  "ufw", "lan_routes", "lan_addrs", "lan_subnets", "ssh_conf", "auth_keys"]

// How the phone reaches this machine: over a tailnet (recommended), or over
// the home network when the phone is on the same Wi-Fi.
var MODES = ["tailscale", "lan"]
var MODE_TAILSCALE = "tailscale"
var MODE_LAN = "lan"

// The ports Moshi needs open on the home network: SSH, and Mosh's UDP range.
var SSH_PORT = "22"
var MOSH_PORTS = "60000:61000"
// One subnet per line, appended by the firewall step once its rules went in
// and removed by the matching close step. It is the record of what this plugin
// opened (no root needed to read it back, unlike `ufw status`).
var LAN_SUBNETS = "~/.local/state/pocket-pair/lan-subnets"

// The one file Pocket Pair adds to the SSH server's configuration, only in
// home-network mode. It sorts ahead of the packaged drop-ins, and sshd keeps
// the first value it reads, so it wins over them. The main sshd_config is never
// edited.
var SSH_DROPIN = "/etc/ssh/sshd_config.d/10-pocket-pair-keyonly.conf"

function normalizeMode(value) {
  return String(value || "") === MODE_LAN ? MODE_LAN : MODE_TAILSCALE
}

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
// installed is "yes" when the tailscale binary exists, so a stopped daemon
// reads as "not connected" rather than "not installed".
function parseTailscale(statusText, prefsText, installed) {
  var status = parseJson(statusText)
  var prefs = parseJson(prefsText)
  var result = { state: installed === "yes" ? "down" : "missing", ip: "", ssh: null }
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

function ipv4ToInt(text) {
  var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || ""))
  if (!match) return -1
  var value = 0
  for (var i = 1; i <= 4; i++) {
    var octet = parseInt(match[i], 10)
    if (octet > 255) return -1
    value = value * 256 + octet
  }
  return value
}

function intToIpv4(value) {
  return [Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256, value % 256].join(".")
}

// RFC 1918, and no wider than the private block itself, so a /7 that happens
// to contain 10.x is never accepted as "your home network".
function isPrivateSubnet(base, prefix) {
  var blocks = [[ipv4ToInt("10.0.0.0"), 8], [ipv4ToInt("172.16.0.0"), 12], [ipv4ToInt("192.168.0.0"), 16]]
  for (var i = 0; i < blocks.length; i++) {
    var size = Math.pow(2, 32 - blocks[i][1])
    if (prefix >= blocks[i][1] && base >= blocks[i][0] && base < blocks[i][0] + size) return true
  }
  return false
}

// Finds the home-network address from the default route's interface:
// `ip -j route show default` and `ip -j -4 addr show`. ok is true only with a
// private address in a subnet that can be named; otherwise error says why.
function parseLan(routesText, addrsText) {
  var none = { ok: false, ip: "", subnet: "", prefix: 0, dev: "", error: "" }
  var routes = parseJson(routesText)
  var addrs = parseJson(addrsText)
  if (!Array.isArray(routes) || routes.length === 0 || !Array.isArray(addrs)) {
    none.error = "No home network found. Connect to Wi-Fi or Ethernet and this continues by itself."
    return none
  }
  var best = null
  routes.forEach(function(route) {
    var dev = String(route.dev || "")
    if (dev === "" || /^(tailscale|tun|tap|wg|ppp)/.test(dev)) return
    var metric = typeof route.metric === "number" ? route.metric : 0
    if (!best || metric < best.metric) best = { dev: dev, metric: metric }
  })
  if (!best) {
    none.error = "No home network found. Connect to Wi-Fi or Ethernet and this continues by itself."
    return none
  }
  none.dev = best.dev
  var info = null
  addrs.forEach(function(iface) {
    if (iface.ifname !== best.dev || info) return
    ;(iface.addr_info || []).forEach(function(a) {
      if (!info && a.family === "inet" && a.scope === "global" && typeof a.prefixlen === "number") info = a
    })
  })
  var ip = info ? ipv4ToInt(info.local) : -1
  if (ip < 0) {
    none.error = "No home-network address found on " + best.dev + "."
    return none
  }
  var prefix = info.prefixlen
  var size = Math.pow(2, 32 - prefix)
  var base = Math.floor(ip / size) * size
  var subnet = intToIpv4(base) + "/" + prefix
  var result = { ok: false, ip: info.local, subnet: subnet, prefix: prefix, dev: best.dev, error: "" }
  if (!isPrivateSubnet(ip, prefix)) {
    result.error = "This connection (" + info.local + ") is not a home network address, so Pocket Pair will not open the firewall for it. Use Tailscale instead."
    return result
  }
  if (prefix > 30) {
    result.error = "Could not work out the subnet of " + info.local + ". Use Tailscale instead."
    return result
  }
  result.ok = true
  return result
}

// The recorded subnets arrive comma-joined. Each one ends up inside a shell
// command, so only a canonical private IPv4 subnet is kept.
function parseSubnets(text) {
  var list = []
  String(text || "").split(",").forEach(function(item) {
    var match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(item.trim())
    if (!match) return
    var base = ipv4ToInt(match[1])
    var prefix = parseInt(match[2], 10)
    if (base < 0 || prefix > 30 || !isPrivateSubnet(base, prefix)) return
    var size = Math.pow(2, 32 - prefix)
    if (base % size !== 0) return
    var subnet = intToIpv4(base) + "/" + prefix
    if (list.indexOf(subnet) < 0) list.push(subnet)
  })
  return list
}

// What the readable SSH server configuration says about signing in. `text` is
// scripts/read-sshd-config.sh's output (Include lines already expanded in
// place), its lines joined with U+001F so it fits on one check line.
//
// Returns "keyonly" only when it can be proven from that text; "password" when
// password or keyboard-interactive login is provably on; "unknown" for
// everything else (an unreadable file, an AuthenticationMethods that is not
// plain publickey, an odd value); "match" when a Match block touches sign-in,
// which sshd -T does not evaluate, so only the user can review it. The gate
// treats all but "keyonly" the same: stop. The authoritative answer is
// `sshd -T`, which the terminal steps run as root.
//
// sshd keeps the first value it reads for these keywords, defaults to
// passwords on, and treats ChallengeResponseAuthentication as another name for
// KbdInteractiveAuthentication.
var SSH_AUTH_KEYWORDS = {
  passwordauthentication: "password",
  kbdinteractiveauthentication: "kbd",
  challengeresponseauthentication: "kbd",
  authenticationmethods: "methods",
  pubkeyauthentication: "pubkey"
}

function parseSshPolicy(text) {
  var lines = String(text || "").split(/[\u001f\r\n]/)
  var first = {}
  var inMatch = false
  var touchedInMatch = false
  var unresolved = lines.every(function(l) { return l.trim() === "" })
  lines.forEach(function(raw) {
    var line = raw.trim()
    if (line === "" || line.charAt(0) === "#") return
    var parsed = /^([A-Za-z0-9]+)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (!parsed) { unresolved = true; return }
    var keyword = parsed[1].toLowerCase()
    var words = parsed[2].split(/\s+/)
    var cut = words.findIndex(function(w) { return w.charAt(0) === "#" })
    if (cut >= 0) words = words.slice(0, cut)
    var value = words.join(" ").replace(/^"(.*)"$/, "$1").toLowerCase()
    if (keyword === "match") { inMatch = true; return }
    if (keyword === "include" || keyword === "pocketpairunresolved") { unresolved = true; return }
    var slot = SSH_AUTH_KEYWORDS[keyword]
    if (!slot) return
    if (inMatch) { touchedInMatch = true; return }
    if (first[slot] === undefined) first[slot] = value
  })
  if (unresolved) return "unknown"
  if (touchedInMatch) return "match"
  var password = first.password === undefined ? "yes" : first.password
  var kbd = first.kbd === undefined ? "yes" : first.kbd
  if (password === "yes" || kbd === "yes") return "password"
  if (password !== "no" || kbd !== "no") return "unknown"
  if (first.pubkey !== undefined && first.pubkey !== "yes") return "unknown"
  var methods = first.methods === undefined ? "any" : first.methods
  if (methods === "any" || methods === "publickey") return "keyonly"
  return /password|keyboard-interactive/.test(methods) ? "password" : "unknown"
}

// auth_keys is a count, or "unknown" when ~/.ssh/authorized_keys exists but
// cannot be read. -1 means unknown. Never keys themselves.
function parseKeyCount(value) {
  var text = String(value === undefined ? "" : value).trim()
  return /^\d{1,6}$/.test(text) ? parseInt(text, 10) : -1
}

function parseUfw(text) {
  var state = String(text || "").trim()
  return state === "active" ? "active" : state === "" || state === "missing" ? "missing" : "inactive"
}

function buildChecks(raw, latestText) {
  raw = raw || {}
  var version = parseVersion(raw.hook_version)
  var latest = parseVersion(latestText)
  var present = !!raw.hook_path && version !== ""
  var lan = parseLan(raw.lan_routes, raw.lan_addrs)
  var openSubnets = parseSubnets(raw.lan_subnets)
  var policy = parseSshPolicy(raw.ssh_conf)
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
    ssh: { policy: policy, keyOnly: policy === "keyonly", keys: parseKeyCount(raw.auth_keys) },
    tailscale: parseTailscale(raw.ts_status, raw.ts_prefs, raw.ts_bin),
    lan: lan,
    ufw: parseUfw(raw.ufw),
    openSubnets: openSubnets,
    // The rules are "open" once the firewall step recorded this subnet.
    firewallOpen: lan.ok && openSubnets.indexOf(lan.subnet) >= 0
  }
}

// The commands that need root, in the order a first pairing needs them.
// Fixed strings: the terminal shows these exact words and nothing is built
// from machine output, except the firewall rules, whose only variable part is
// a subnet that parseLan has already checked is a private IPv4 range.
var FIXES = {
  mosh: { cmd: "sudo pacman -S mosh", why: "mosh-server, so the phone can use Mosh" },
  sshd: { cmd: "sudo systemctl enable --now sshd", why: "the SSH server Moshi connects to" },
  tsssh: { cmd: "sudo tailscale set --ssh=false", why: "so port 22 reaches sshd, not Tailscale" }
}

// Tailscale itself: install if missing, start the service, sign in.
var TAILSCALE_INSTALL = { id: "ts-install", cmd: "sudo pacman -S tailscale", why: "Tailscale, the recommended way to reach this machine" }
var TAILSCALE_ENABLE = { id: "ts-enable", cmd: "sudo systemctl enable --now tailscaled", why: "the Tailscale service" }
var TAILSCALE_UP = { id: "ts-up", cmd: "sudo tailscale up", why: "sign in to your tailnet" }

function tailscaleFixes(tailscale) {
  var list = []
  if (tailscale.state === "missing") list.push(TAILSCALE_INSTALL)
  list.push(TAILSCALE_ENABLE)
  list.push(TAILSCALE_UP)
  return list
}

// "Key-only" as sshd itself reports it: `sshd -T` prints the effective
// configuration (needs root, so it runs in the terminal step). All four lines
// must be there; a missing or different line fails the check. Match blocks are
// not evaluated by -T, so a Match block that touches sign-in fails it too.
var SSH_MATCH = "[ \"$(sudo awk 'tolower($0) ~ /^[ \\t]*match[ \\t=]/ { m = 1 }"
  + " m && tolower($0) ~ /^[ \\t]*(passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication|authenticationmethods|pubkeyauthentication)[ \\t=]/ { f = 1 }"
  + " END { print f + 0 }' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf)\" = 0 ]"
var SSH_VERIFY = "[ \"$(sudo sshd -T | grep -ixcE \"(passwordauthentication|kbdinteractiveauthentication) no"
  + "|pubkeyauthentication yes|authenticationmethods (any|publickey)\")\" = 4 ] && " + SSH_MATCH

// Every command is fixed text. A failing check removes only Pocket Pair's own
// file again, says why, and stops the chain (the `false`), so nothing after it
// runs. Existing SSH sessions are not cut: the reload only applies to new ones.
function keyOnlyFixes() {
  var remove = "sudo rm -f " + SSH_DROPIN
  return [
    {
      id: "ssh-conf",
      cmd: "printf \"%s\\n\" \"# Written by Pocket Pair: SSH accepts keys only. Delete this file and run"
        + " sudo systemctl reload sshd to allow passwords again.\" \"PasswordAuthentication no\""
        + " \"KbdInteractiveAuthentication no\" | sudo install -Dm644 /dev/stdin " + SSH_DROPIN,
      why: "turn off password sign-in for SSH (keys only)"
    },
    {
      id: "ssh-test",
      cmd: "sudo sshd -t || { " + remove + "; echo \"sshd rejected its configuration. Pocket Pair removed"
        + " its file and changed nothing else.\"; false; }",
      why: "check sshd accepts its configuration"
    },
    {
      id: "ssh-verify",
      cmd: SSH_VERIFY + " || { " + remove + "; echo \"sshd is not keys only after all: an earlier rule overrides the"
        + " Pocket Pair file, AuthenticationMethods allows more, or a Match block touches sign-in. The file was removed. Review that yourself, or use Tailscale.\"; false; }",
      why: "confirm sshd really is keys only now"
    },
    {
      id: "ssh-reload",
      cmd: "{ ! systemctl is-active --quiet sshd || sudo systemctl reload sshd; }",
      why: "apply it to new connections (open sessions stay)"
    }
  ]
}

// Words for the panel and for the terminal, shown before anything runs. Counts
// only: the keys themselves are never read into the panel.
function keyOnlyNotes(checks) {
  var ssh = checks.ssh
  var notes = [ssh.policy === "password"
    ? "SSH on this machine still accepts passwords. Pocket Pair turns password and keyboard-interactive sign-in off before it opens SSH to your network."
    : "Pocket Pair cannot prove from the SSH configuration that passwords are off. It turns them off and checks the result with sshd -T."]
  if (ssh.keys > 0) {
    notes.push(ssh.keys + (ssh.keys === 1 ? " key is" : " keys are") + " already in ~/.ssh/authorized_keys and keep working.")
  } else if (ssh.keys === 0) {
    notes.push("No keys were found in ~/.ssh/authorized_keys. Unless keys come from elsewhere (AuthorizedKeysFile, AuthorizedKeysCommand),"
      + " nobody can sign in over SSH until your phone pairs."
      + (checks.sshd ? " Anyone who signs in with a password today will stop being able to." : ""))
  } else {
    notes.push("~/.ssh/authorized_keys could not be read, so its keys were not counted.")
  }
  notes.push("Sessions already open stay connected.")
  return notes
}

// The firewall rules for the home network. Every rule says `from <subnet>`;
// there is deliberately no variant without it.
function lanRules(subnet) {
  return {
    ssh: "sudo ufw allow from " + subnet + " to any port " + SSH_PORT + " proto tcp",
    mosh: "sudo ufw allow from " + subnet + " to any port " + MOSH_PORTS + " proto udp",
    sshDelete: "sudo ufw delete allow from " + subnet + " to any port " + SSH_PORT + " proto tcp",
    moshDelete: "sudo ufw delete allow from " + subnet + " to any port " + MOSH_PORTS + " proto udp",
    remember: "mkdir -p ~/.local/state/pocket-pair && { grep -qxF " + subnet + " " + LAN_SUBNETS + " 2>/dev/null || echo " + subnet + " >> " + LAN_SUBNETS + "; }",
    forget: "sed -i \"\\|^" + subnet.replace(/\./g, "\\.") + "\\$|d\" " + LAN_SUBNETS
  }
}

function firewallFixes(subnet) {
  var rules = lanRules(subnet)
  return [
    {
      id: "fw-check",
      cmd: SSH_VERIFY + " || { echo \"SSH does not accept keys only (or a Match block touches sign-in), so the firewall was not opened.\"; false; }",
      why: "make sure SSH accepts keys only before opening it"
    },
    { id: "fw-ssh", cmd: rules.ssh, why: "SSH from your home network only" },
    { id: "fw-mosh", cmd: rules.mosh, why: "Mosh from your home network only" },
    { id: "fw-note", cmd: rules.remember, why: "remember it is open (no root)" }
  ]
}

// Closes every recorded subnet; each is forgotten only after both of its
// deletes succeeded.
function closeFixes(subnets) {
  var list = []
  subnets.forEach(function(subnet) {
    var rules = lanRules(subnet)
    list.push({ id: "fw-ssh-close", cmd: rules.sshDelete, why: "close SSH again for " + subnet })
    list.push({ id: "fw-mosh-close", cmd: rules.moshDelete, why: "close Mosh again for " + subnet })
    list.push({ id: "fw-note-close", cmd: rules.forget, why: "forget " + subnet + " (no root)" })
  })
  return list
}

function pendingFixes(checks, mode) {
  var lan = normalizeMode(mode) === MODE_LAN
  var list = []
  if (!checks.mosh) list.push({ id: "mosh", cmd: FIXES.mosh.cmd, why: FIXES.mosh.why })
  // Key-only goes in before sshd is started or opened: the drop-in is only a
  // file, so a server that is off never listens with passwords on.
  if (lan && !checks.ssh.keyOnly && checks.ssh.policy !== "match") list = list.concat(keyOnlyFixes())
  if (!checks.sshd) list.push({ id: "sshd", cmd: FIXES.sshd.cmd, why: FIXES.sshd.why })
  if (lan) {
    if (checks.ssh.keyOnly && checks.ufw === "active" && checks.lan.ok && !checks.firewallOpen) {
      list = list.concat(firewallFixes(checks.lan.subnet))
    }
  } else if (checks.tailscale.ssh === true) {
    list.push({ id: "tsssh", cmd: FIXES.tsssh.cmd, why: FIXES.tsssh.why })
  }
  return list
}

// The checklist the panel shows while something is still missing.
function checklist(checks, mode) {
  var rows = [{
    id: "hook", label: "moshi-hook",
    state: checks.hook.present ? "ok" : "todo",
    detail: checks.hook.present ? checks.hook.version : "not installed"
  }]
  if (normalizeMode(mode) === MODE_LAN) {
    rows.push({
      id: "lan", label: "Home network",
      state: checks.lan.ok ? "ok" : "wait",
      detail: checks.lan.ok ? checks.lan.subnet : "not found"
    })
  } else {
    var ts = checks.tailscale
    rows.push({
      id: "tailscale", label: "Tailscale",
      state: ts.state === "running" ? "ok" : "wait",
      detail: ts.state === "running" ? ts.ip : ts.state === "missing" ? "not installed" : "not connected"
    })
  }
  rows.push({
    id: "mosh", label: "mosh-server",
    state: checks.mosh ? "ok" : "todo",
    detail: checks.mosh ? "installed" : "missing"
  })
  rows.push({
    id: "sshd", label: "SSH server",
    state: checks.sshd ? "ok" : "todo",
    detail: checks.sshd ? "running" : "not running"
  })
  if (normalizeMode(mode) === MODE_LAN) {
    rows.push({
      id: "sshauth", label: "SSH sign-in",
      state: checks.ssh.keyOnly ? "ok" : checks.ssh.policy === "match" ? "wait" : "todo",
      detail: checks.ssh.keyOnly ? "keys only"
        : checks.ssh.policy === "password" ? "passwords on"
        : checks.ssh.policy === "match" ? "Match block: review by hand" : "not verified"
    })
    rows.push({
      id: "sshkeys", label: "Authorized keys",
      state: "ok",
      detail: checks.ssh.keys > 0 ? checks.ssh.keys + " already" : checks.ssh.keys === 0 ? "none yet" : "not counted"
    })
    rows.push({
      id: "firewall", label: "Firewall",
      state: checks.ufw !== "active" || checks.firewallOpen ? "ok" : checks.lan.ok && checks.ssh.keyOnly ? "todo" : "wait",
      detail: checks.ufw !== "active" ? "not in use" : checks.firewallOpen ? "open to your network" : "closed"
    })
  } else {
    rows.push({
      id: "tsssh", label: "Tailscale SSH",
      state: checks.tailscale.ssh === true ? "todo" : "ok",
      detail: checks.tailscale.ssh === true ? "on" : "off"
    })
  }
  return rows
}

// The address the phone is paired against.
function pairHost(checks, mode) {
  if (normalizeMode(mode) === MODE_LAN) return checks.lan.ok ? checks.lan.ip : ""
  return checks.tailscale.state === "running" ? checks.tailscale.ip : ""
}

// Whether a pairing session may start. The home network also needs SSH to
// accept keys only, whatever the next step says.
function canPair(checks, mode) {
  if (pairHost(checks, mode) === "") return false
  return normalizeMode(mode) !== MODE_LAN || checks.ssh.keyOnly
}

// One primary action at a time. kind: install, fix, wait, pair, done.
// A fix step carries `alt` when the other network option is worth offering.
function nextStep(checks, hosts, mode) {
  mode = normalizeMode(mode)
  if (!checks.hook.present) return { kind: "install", label: "Install helper" }
  if (mode === MODE_LAN) {
    if (!checks.lan.ok) return { kind: "wait", label: "Check again", hint: checks.lan.error }
  } else if (checks.tailscale.state !== "running") {
    return {
      kind: "fix", label: "Set up Tailscale", recommended: true,
      hint: "Recommended: reach this machine from anywhere, with no firewall changes.",
      fixes: tailscaleFixes(checks.tailscale),
      alt: { mode: MODE_LAN, label: "Use my home network instead" }
    }
  }
  if (mode === MODE_LAN && checks.ssh.policy === "match") {
    return {
      kind: "wait", label: "Check again",
      hint: "A Match block in your SSH configuration touches sign-in (passwords, keys or AuthenticationMethods), which Pocket Pair cannot verify."
        + " Review it yourself so it allows keys only, or use Tailscale. Pocket Pair never edits it."
    }
  }
  var fixes = pendingFixes(checks, mode)
  if (fixes.length > 0) {
    var ids = fixes.map(function(fix) { return fix.id })
    var firewallOnly = ids.every(function(id) { return id.indexOf("fw-") === 0 })
    var keyOnlyOnly = ids.every(function(id) { return id.indexOf("ssh-") === 0 })
    var step = {
      kind: "fix",
      label: firewallOnly ? "Open firewall for your home network"
        : keyOnlyOnly ? "Make SSH keys-only"
        : fixes.length === 1 ? "Fix in a terminal" : "Set up in a terminal",
      fixes: fixes
    }
    if (ids.indexOf("ssh-conf") >= 0) {
      step.notes = keyOnlyNotes(checks)
      step.hint = step.notes.join(" ")
    }
    return step
  }
  if (hosts && hosts.length > 0) return { kind: "done", label: "Pair another phone" }
  return { kind: "pair", label: "Show QR" }
}

// A one-line script for the floating terminal: it prints every command before
// running any of them, then stops at the first failure. `notes` are printed
// first, for what the user should know before the password prompt.
function fixScript(fixes, heading, notes) {
  var say = function(text) { return "echo '" + String(text).replace(/'/g, "'\\''") + "'" }
  var parts = [say(heading || "Pocket Pair will run:")]
  ;(notes || []).forEach(function(note) { parts.push(say(note)) })
  fixes.forEach(function(fix) { parts.push(say("  $ " + fix.cmd)) })
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
    GLYPHS: GLYPHS, PAIR_SECONDS: PAIR_SECONDS, FIXES: FIXES, MODES: MODES,
    normalizeMode: normalizeMode, parseLan: parseLan, parseSubnets: parseSubnets, parseUfw: parseUfw,
    parseSshPolicy: parseSshPolicy, parseKeyCount: parseKeyCount, keyOnlyFixes: keyOnlyFixes,
    keyOnlyNotes: keyOnlyNotes, canPair: canPair, SSH_DROPIN: SSH_DROPIN, SSH_VERIFY: SSH_VERIFY, SSH_MATCH: SSH_MATCH,
    lanRules: lanRules, firewallFixes: firewallFixes, closeFixes: closeFixes,
    tailscaleFixes: tailscaleFixes, pairHost: pairHost,
    parseVersion: parseVersion, compareVersions: compareVersions,
    parseCheckOutput: parseCheckOutput, parseTailscale: parseTailscale,
    buildChecks: buildChecks, pendingFixes: pendingFixes, checklist: checklist,
    nextStep: nextStep, fixScript: fixScript, parseHostList: parseHostList,
    isHostId: isHostId, parseSetupLine: parseSetupLine, parseQrAscii: parseQrAscii,
    formatCountdown: formatCountdown, scrub: scrub
  }
}
