import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Pocket Pair's engine: everything the machine is asked, and the two processes
// it owns (the helper install and the pairing session).
//
// It lives on the bar widget so the bar glyph can show the paired state while
// the panel is closed, and so closing the panel can cancel a pairing session
// that would otherwise keep a link alive.
//
// Root never runs from here. The fixes that need it (including the home-network
// key-only SSH drop-in, the firewall rules and closing them again) are handed to Omarchy's floating terminal, which shows the commands and asks for the
// password itself; this file only notices, by polling, when they worked.
//
// The pairing link is an access token. It is read from one line of stdout,
// passed to qrencode through the environment of that one process, and then
// dropped; it is never stored in a property, logged, or written anywhere.

QtObject {
  id: engine

  required property var host
  // The panel sets this while it is open: the checks then run every few
  // seconds, so a fix finished in the terminal is noticed within moments.
  property bool panelOpen: false

  readonly property string pluginDir: Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "")
  readonly property string hookOverride: host && host.settings && host.settings.hookBinary
    ? String(host.settings.hookBinary) : ""

  // ----------------------------------------------------------------- checks
  property var rawChecks: ({})
  readonly property var checks: Model.buildChecks(rawChecks, latestText)
  property bool checked: false
  property var hosts: []
  property string latestText: ""
  property double latestAt: 0
  property bool fixLaunched: false

  // How the phone reaches this machine: "tailscale" (recommended) or "lan".
  // Kept in the widget's own settings so it survives a restart.
  readonly property string network: Model.normalizeMode(host && host.settings ? host.settings.network : "")
  readonly property bool lanMode: network === "lan"

  function setNetwork(mode) {
    mode = Model.normalizeMode(mode)
    if (mode === network) return
    dismissPair()
    fixLaunched = false
    var entry = { id: host.moduleName }
    for (var key in host.settings) if (key !== "id") entry[key] = host.settings[key]
    entry.network = mode
    // Applied locally first so the panel changes on the click itself; the
    // shell.json write comes back through the bar as the same value.
    host.settings = entry
    if (host.bar && host.bar.shell && typeof host.bar.shell.updateEntryInline === "function")
      host.bar.shell.updateEntryInline(host.moduleName, entry)
    refresh()
  }

  readonly property string hookPath: checks.hook.present ? checks.hook.path : ""
  readonly property var step: Model.nextStep(checks, hosts, network)
  readonly property var checklist: Model.checklist(checks, network)
  readonly property bool canCloseFirewall: checks.openSubnets.length > 0
  readonly property bool paired: hosts.length > 0
  readonly property bool busy: installProc.running || updateProc.running || pairState === "starting" || pairState === "waiting"

  readonly property string checkScript: [
    'bin="$1"',
    '[ -n "$bin" ] || bin=$(command -v moshi-hook 2>/dev/null || true)',
    '[ -n "$bin" ] || { [ -x "$HOME/.local/bin/moshi-hook" ] && bin="$HOME/.local/bin/moshi-hook"; }',
    'echo "hook_path=$bin"',
    'if [ -n "$bin" ]; then echo "hook_version=$(timeout 5 "$bin" --version 2>/dev/null | head -n1)"; fi',
    'echo "daemon=$(systemctl --user is-active moshi-hook 2>/dev/null)"',
    'if command -v mosh-server >/dev/null 2>&1; then echo mosh=yes; else echo mosh=no; fi',
    'echo "sshd=$(systemctl is-active sshd 2>/dev/null)"',
    'if command -v tailscale >/dev/null 2>&1; then',
    '  echo ts_bin=yes',
    '  echo "ts_status=$(timeout 5 tailscale status --json --peers=false 2>/dev/null | tr -d "\\n")"',
    '  echo "ts_prefs=$(timeout 5 tailscale debug prefs 2>/dev/null | tr -d "\\n")"',
    'fi',
    'if command -v ufw >/dev/null 2>&1; then echo "ufw=$(systemctl is-active ufw 2>/dev/null)"; else echo ufw=missing; fi',
    'echo "lan_routes=$(ip -j route show default 2>/dev/null | tr -d "\\n")"',
    'echo "lan_addrs=$(ip -j -4 addr show 2>/dev/null | tr -d "\\n")"',
    'echo "lan_subnets=$(paste -sd, "$HOME/.local/state/pocket-pair/lan-subnets" 2>/dev/null)"',
    // What SSH accepts: the readable config (passive state only; the terminal
    // steps ask sshd itself) and how many keys are already authorized. Only
    // the count leaves this script, never a key.
    'echo "ssh_conf=$(bash "$2/scripts/read-sshd-config.sh" 2>/dev/null | tr "\\n" "\\037")"',
    'ak="$HOME/.ssh/authorized_keys"',
    'if [ ! -e "$ak" ]; then echo auth_keys=0',
    'elif [ ! -r "$ak" ] || ! command -v ssh-keygen >/dev/null 2>&1; then echo auth_keys=unknown',
    'else',
    '  n=0',
    '  while IFS= read -r l || [ -n "$l" ]; do',
    '    [[ $l =~ ^[[:space:]]*(#|$) ]] && continue',
    '    ssh-keygen -lf /dev/stdin <<<"$l" >/dev/null 2>&1 && n=$((n + 1))',
    '  done <"$ak"',
    '  echo "auth_keys=$n"',
    'fi'
  ].join("\n")

  function refresh() {
    if (!checkProc.running) {
      checkProc.command = ["bash", "-c", engine.checkScript, "pocket-pair", engine.hookOverride, engine.pluginDir]
      checkProc.running = true
    }
    // The latest release only changes when Moshi ships, so ask at most hourly.
    if (!latestProc.running && Date.now() - latestAt > 3600000) {
      latestAt = Date.now()
      latestProc.running = true
    }
  }

  function refreshHosts() {
    if (!hookPath || hostsProc.running) return
    hostsProc.command = [hookPath, "host", "list"]
    hostsProc.running = true
  }

  property Process checkProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        engine.rawChecks = Model.parseCheckOutput(text)
        engine.checked = true
        if (engine.step.kind !== "fix") engine.fixLaunched = false
        // A pairing session on the home network ends if SSH stops being
        // key-only underneath it.
        if (engine.lanMode && !Model.canPair(engine.checks, engine.network)
            && (engine.pairState === "starting" || engine.pairState === "waiting")) {
          engine.cancelPair()
          engine.pairState = "error"
          engine.pairError = "SSH no longer accepts keys only, so pairing was stopped."
        }
        engine.refreshHosts()
      }
    }
  }

  property Process latestProc: Process {
    command: ["curl", "--proto", "=https", "-fsS", "--max-time", "8", "https://cdn.getmoshi.app/hook/latest/version.txt"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var version = Model.parseVersion(text)
        if (version === "") return
        engine.latestText = version
      }
    }
  }

  property Process hostsProc: Process {
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: engine.hosts = Model.parseHostList(text)
    }
  }

  property Timer poller: Timer {
    interval: engine.panelOpen || engine.fixLaunched ? 3000 : 30000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: engine.refresh()
  }

  // ---------------------------------------------------------------- install
  property string installLine: ""
  property string installError: ""

  function installHelper() {
    if (installProc.running) return
    installLine = "Starting…"
    installError = ""
    installProc.command = ["bash", engine.pluginDir + "scripts/install-moshi-hook.sh"]
    installProc.running = true
  }

  property Process installProc: Process {
    stdout: SplitParser {
      onRead: function(line) { engine.installLine = String(line).replace(/^==>\s*/, "") }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") engine.installError = Model.scrub(text)
    }
    onExited: function(code) {
      if (code !== 0 && engine.installError === "") engine.installError = "The install did not finish."
      engine.installLine = ""
      engine.refresh()
    }
  }

  property Process updateProc: Process {
    onExited: engine.refresh()
  }

  function updateHelper() {
    if (!hookPath || updateProc.running) return
    updateProc.command = [hookPath, "update"]
    updateProc.running = true
  }

  // ------------------------------------------------------------------ fixes
  function runFixes() {
    var fixes = engine.step.fixes
    if (!fixes || fixes.length === 0) return
    engine.fixLaunched = true
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
      Model.fixScript(fixes, undefined, engine.step.notes)])
  }

  // Closes the home-network firewall rules again, in the same kind of visible
  // terminal. Only the rules this plugin recorded opening, whichever network
  // or mode the panel is in now.
  function closeFirewall() {
    if (!canCloseFirewall) return
    fixLaunched = true
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation",
      Model.fixScript(Model.closeFixes(checks.openSubnets), "Pocket Pair will close the firewall again:")])
  }

  // ---------------------------------------------------------------- pairing
  // idle, starting, waiting (QR on screen), ready, expired, error
  property string pairState: "idle"
  property string pairError: ""
  property var qrRows: []
  property int qrSize: 0
  property int secondsLeft: 0
  property bool pairExpectedStop: false

  function startPair() {
    var address = Model.pairHost(checks, network)
    // On the home network nothing pairs until SSH accepts keys only.
    if (pairProc.running || !hookPath || address === "" || !Model.canPair(checks, network)) return
    pairError = ""
    qrRows = []
    qrSize = 0
    pairState = "starting"
    pairExpectedStop = false
    pairProc.command = [hookPath, "host", "setup", "--json", "--host", address]
    pairProc.running = true
  }

  function cancelPair() {
    if (pairProc.running) {
      pairExpectedStop = true
      pairProc.running = false
    }
    qrRows = []
    qrSize = 0
    secondsLeft = 0
    if (pairState === "starting" || pairState === "waiting") pairState = "idle"
  }

  function dismissPair() {
    cancelPair()
    pairState = "idle"
    pairError = ""
  }

  function showQr(link) {
    qrProc.environment = { "POCKET_PAIR_LINK": link }
    qrProc.running = true
    // The environment has been handed to the child; do not keep the link here.
    qrProc.environment = ({})
  }

  function handleSetupLine(line) {
    if (pairExpectedStop) return
    var message = Model.parseSetupLine(line)
    if (!message) return
    if (message.status === "pending" && message.deepLink !== "") {
      engine.showQr(message.deepLink)
    } else if (message.status === "ready") {
      engine.qrRows = []
      engine.qrSize = 0
      engine.pairState = "ready"
      restartProc.command = [engine.hookPath, "service", "restart"]
      restartProc.running = true
      engine.refreshHosts()
    } else if (message.error !== "") {
      engine.pairError = Model.scrub(message.error)
    }
  }

  property Process pairProc: Process {
    stdout: SplitParser {
      onRead: function(line) { engine.handleSetupLine(line) }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "" && engine.pairError === "") engine.pairError = Model.scrub(text)
    }
    onExited: function(code) {
      if (engine.pairExpectedStop) return
      if (engine.pairState === "ready") return
      engine.qrRows = []
      engine.qrSize = 0
      engine.pairState = "error"
      if (engine.pairError === "") engine.pairError = "Pairing ended before the phone finished."
      engine.refresh()
    }
  }

  property Process qrProc: Process {
    command: ["bash", "-c", "printf %s \"$POCKET_PAIR_LINK\" | qrencode -t ASCII -m 4 -o -"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (engine.pairExpectedStop) return
        var parsed = Model.parseQrAscii(text)
        if (parsed.size === 0) {
          engine.cancelPair()
          engine.pairState = "error"
          engine.pairError = "Could not draw the QR code."
          return
        }
        engine.qrRows = parsed.rows
        engine.qrSize = parsed.size
        engine.secondsLeft = Model.PAIR_SECONDS
        engine.pairState = "waiting"
      }
    }
  }

  property Process restartProc: Process {
    onExited: engine.refresh()
  }

  property Timer countdown: Timer {
    interval: 1000
    repeat: true
    running: engine.pairState === "waiting"
    onTriggered: {
      engine.secondsLeft = engine.secondsLeft - 1
      if (engine.secondsLeft <= 0) {
        engine.cancelPair()
        engine.pairState = "expired"
      }
    }
  }

  // ----------------------------------------------------------------- revoke
  property string revokeError: ""

  function revoke(id) {
    if (!Model.isHostId(id) || !hookPath || revokeProc.running) return
    revokeError = ""
    revokeProc.command = [hookPath, "host", "revoke", id]
    revokeProc.running = true
  }

  property Process revokeProc: Process {
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") engine.revokeError = Model.scrub(text)
    }
    onExited: engine.refreshHosts()
  }

  Component.onDestruction: {
    if (pairProc.running) {
      pairExpectedStop = true
      pairProc.running = false
    }
  }
}
