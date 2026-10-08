import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const M = createRequire(import.meta.url)("../Model.js")

const status = (backend, ips = ["100.64.0.1", "fd7a::1"]) =>
  JSON.stringify({ BackendState: backend, Self: { TailscaleIPs: ips } })

const ROUTES = JSON.stringify([{ dst: "default", dev: "wlan0", metric: 600 }])
const addrs = (dev, ip, prefixlen) => JSON.stringify([
  { ifname: "lo", addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8, scope: "host" }] },
  { ifname: dev, addr_info: [{ family: "inet", local: ip, prefixlen, scope: "global" }] }
])

const ready = {
  hook_path: "/h/moshi-hook", hook_version: "moshi-hook version 0.4.20", daemon: "active",
  mosh: "yes", sshd: "active", ts_bin: "yes", ts_status: status("Running"), ts_prefs: '{"RunSSH": false}',
  ufw: "active", lan_routes: ROUTES, lan_addrs: addrs("wlan0", "192.168.1.16", 24), lan_marker: ""
}

test("versions parse and compare", () => {
  assert.equal(M.parseVersion("moshi-hook version 0.4.15"), "0.4.15")
  assert.equal(M.parseVersion("v0.4.20\n"), "0.4.20")
  assert.equal(M.compareVersions("0.4.15", "v0.4.20"), -1)
  assert.equal(M.compareVersions("0.10.0", "0.9.9"), 1)
  assert.equal(M.compareVersions("0.4.15", ""), 0)
})

test("check output keeps only known keys", () => {
  const raw = M.parseCheckOutput("mosh=yes\nevil=1\nnoise\nsshd=inactive")
  assert.deepEqual(raw, { mosh: "yes", sshd: "inactive" })
})

test("tailscale: running, down, missing, unknown ssh", () => {
  assert.deepEqual(M.parseTailscale(status("Running"), '{"RunSSH": true}'), { state: "running", ip: "100.64.0.1", ssh: true })
  assert.equal(M.parseTailscale(status("Stopped"), "").state, "down")
  assert.equal(M.parseTailscale(status("Running", []), "").state, "down")
  assert.equal(M.parseTailscale("", "").state, "missing")
  assert.equal(M.parseTailscale(status("Running"), "").ssh, null)
})

test("next step walks install, wait, fix, pair, done", () => {
  const build = (over) => M.buildChecks({ ...ready, ...over }, "v0.4.20")
  assert.equal(M.nextStep(build({ hook_path: "", hook_version: "" }), []).kind, "install")
  assert.equal(M.nextStep(build({ ts_status: "", ts_bin: "" }), []).kind, "fix")
  assert.equal(M.nextStep(build({ ts_status: status("Stopped") }), []).kind, "fix")
  const fix = M.nextStep(build({ mosh: "no", sshd: "inactive", ts_prefs: '{"RunSSH": true}' }), [])
  assert.equal(fix.kind, "fix")
  assert.deepEqual(fix.fixes.map(f => f.cmd), [
    "sudo pacman -S mosh", "sudo systemctl enable --now sshd", "sudo tailscale set --ssh=false"
  ])
  assert.equal(M.nextStep(build({}), []).kind, "pair")
  assert.equal(M.nextStep(build({}), [{ id: "host_x" }]).kind, "done")
})

test("unknown tailscale ssh state does not block pairing", () => {
  assert.equal(M.nextStep(M.buildChecks({ ...ready, ts_prefs: "" }, ""), []).kind, "pair")
})

test("outdated helper is flagged but never blocks", () => {
  const checks = M.buildChecks({ ...ready, hook_version: "0.4.15" }, "0.4.20")
  assert.equal(checks.hook.outdated, true)
  assert.equal(M.nextStep(checks, []).kind, "pair")
})

test("fix script shows every command before running them, stopping on failure", () => {
  const script = M.fixScript(M.pendingFixes(M.buildChecks({ ...ready, mosh: "no", sshd: "inactive" }, "")))
  assert.match(script, /echo '  \$ sudo pacman -S mosh'/)
  assert.ok(script.endsWith("sudo pacman -S mosh && sudo systemctl enable --now sshd"))
  assert.ok(script.indexOf("echo '  $ sudo systemctl") < script.indexOf("sudo pacman -S mosh &&"))
})

test("no fix command touches the firewall or sudoers", () => {
  const all = Object.values(M.FIXES).map(f => f.cmd).join("\n")
  assert.doesNotMatch(all, /ufw|sudoers|sshd_config/)
})

test("host list parses and rejects odd ids", () => {
  const text = "host_99e8:F+wP  me@box.ts.net:22  SHA256:F+wP  active\nbogus line\n"
  const hosts = M.parseHostList(text)
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].id, "host_99e8:F+wP")
  assert.equal(M.isHostId("host_a; rm -rf ~"), false)
  assert.equal(M.isHostId("host_a b"), false)
})

test("setup lines", () => {
  assert.equal(M.parseSetupLine("not json"), null)
  const pending = M.parseSetupLine('{"status":"pending","deepLink":"moshi://x"}')
  assert.equal(pending.status, "pending")
  assert.equal(pending.deepLink, "moshi://x")
  assert.equal(M.parseSetupLine('{"status":"ready"}').status, "ready")
})

test("qr ascii becomes a square matrix; malformed is empty", () => {
  const ok = M.parseQrAscii("##  \n  ##\n")
  assert.deepEqual(ok, { rows: ["10", "01"], size: 2 })
  assert.equal(M.parseQrAscii("##  \n").size, 0)
  assert.equal(M.parseQrAscii("###\n###\n").size, 0)
  assert.equal(M.parseQrAscii("").size, 0)
})

test("countdown formats", () => {
  assert.equal(M.formatCountdown(300), "5:00")
  assert.equal(M.formatCountdown(61), "1:01")
  assert.equal(M.formatCountdown(-3), "0:00")
})

test("scrub hides links and keeps text short", () => {
  assert.equal(M.scrub("failed: moshi://pair?t=SECRET now"), "failed: [link hidden] now")
  assert.ok(M.scrub("x".repeat(500)).length <= 160)
})

const build = (over) => M.buildChecks({ ...ready, ...over }, "v0.4.20")

test("mode defaults to tailscale and only accepts known values", () => {
  assert.equal(M.normalizeMode(undefined), "tailscale")
  assert.equal(M.normalizeMode("lan"), "lan")
  assert.equal(M.normalizeMode("anything else"), "tailscale")
})

test("tailscale missing: Set up Tailscale is primary, with the exact commands and a quiet home-network option", () => {
  const step = M.nextStep(build({ ts_status: "", ts_bin: "" }), [], "tailscale")
  assert.equal(step.label, "Set up Tailscale")
  assert.equal(step.recommended, true)
  assert.deepEqual(step.fixes.map(f => f.cmd), [
    "sudo pacman -S tailscale", "sudo systemctl enable --now tailscaled", "sudo tailscale up"
  ])
  assert.deepEqual(step.alt, { mode: "lan", label: "Use my home network instead" })
})

test("tailscale installed but signed out skips the install command", () => {
  const step = M.nextStep(build({ ts_status: status("NeedsLogin", []) }), [], "tailscale")
  assert.deepEqual(step.fixes.map(f => f.cmd), ["sudo systemctl enable --now tailscaled", "sudo tailscale up"])
  const stopped = M.nextStep(build({ ts_status: "" }), [], "tailscale")
  assert.equal(stopped.fixes[0].cmd, "sudo systemctl enable --now tailscaled")
})

test("tailscale running: no alternative is pushed", () => {
  assert.equal(M.nextStep(build({}), [], "tailscale").alt, undefined)
})

test("lan subnet comes from the default route's interface", () => {
  const lan = M.parseLan(ROUTES, addrs("wlan0", "192.168.1.16", 24))
  assert.deepEqual(lan, { ok: true, ip: "192.168.1.16", subnet: "192.168.1.0/24", prefix: 24, dev: "wlan0", error: "" })
  assert.equal(M.parseLan(ROUTES, addrs("wlan0", "10.20.30.200", 22)).subnet, "10.20.28.0/22")
  assert.equal(M.parseLan(ROUTES, addrs("wlan0", "172.16.5.9", 12)).subnet, "172.16.0.0/12")
})

test("lan picks the lowest-metric default route and ignores tunnels", () => {
  const routes = JSON.stringify([
    { dst: "default", dev: "tailscale0", metric: 1 },
    { dst: "default", dev: "wlan0", metric: 600 },
    { dst: "default", dev: "eth0", metric: 100 }
  ])
  const all = JSON.stringify([
    { ifname: "wlan0", addr_info: [{ family: "inet", local: "192.168.1.16", prefixlen: 24, scope: "global" }] },
    { ifname: "eth0", addr_info: [{ family: "inet", local: "192.168.7.5", prefixlen: 24, scope: "global" }] }
  ])
  assert.equal(M.parseLan(routes, all).subnet, "192.168.7.0/24")
})

test("lan refuses public addresses, tiny subnets and missing detection", () => {
  for (const [ip, prefix] of [["8.8.8.8", 24], ["100.64.0.7", 10], ["172.32.0.4", 16], ["192.169.1.2", 24], ["11.0.0.5", 8]]) {
    const lan = M.parseLan(ROUTES, addrs("wlan0", ip, prefix))
    assert.equal(lan.ok, false, ip)
    assert.match(lan.error, /not a home network address/)
  }
  assert.equal(M.parseLan(ROUTES, addrs("wlan0", "192.168.1.2", 32)).ok, false)
  assert.equal(M.parseLan(ROUTES, addrs("wlan0", "10.1.1.1", 7)).ok, false)
  assert.equal(M.parseLan("", "").ok, false)
  assert.equal(M.parseLan("[]", "[]").ok, false)
  assert.equal(M.parseLan(ROUTES, addrs("eth9", "192.168.1.2", 24)).ok, false)
  assert.match(M.parseLan("", "").error, /No home network found/)
})

test("lan mode waits with a clear message when the address is refused", () => {
  const checks = build({ lan_addrs: addrs("wlan0", "8.8.8.8", 24) })
  const step = M.nextStep(checks, [], "lan")
  assert.equal(step.kind, "wait")
  assert.match(step.hint, /not a home network address/)
  assert.equal(M.pairHost(checks, "lan"), "")
})

test("lan mode skips Tailscale entirely, including Tailscale SSH", () => {
  const checks = build({ ts_status: "", ts_bin: "", lan_marker: "192.168.1.0/24", ts_prefs: '{"RunSSH": true}' })
  assert.equal(M.nextStep(checks, [], "lan").kind, "pair")
  assert.equal(M.pairHost(checks, "lan"), "192.168.1.16")
  assert.equal(M.pairHost(build({}), "tailscale"), "100.64.0.1")
  assert.ok(!M.checklist(checks, "lan").some(row => /tailscale/i.test(row.label)))
})

test("lan mode: the firewall step has the exact scoped commands", () => {
  const step = M.nextStep(build({}), [], "lan")
  assert.equal(step.kind, "fix")
  assert.equal(step.label, "Open firewall for your home network")
  assert.deepEqual(step.fixes.map(f => f.cmd), [
    "sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp",
    "sudo ufw allow from 192.168.1.0/24 to any port 60000:61000 proto udp",
    "mkdir -p ~/.local/state/pocket-pair && echo 192.168.1.0/24 > ~/.local/state/pocket-pair/lan-subnet"
  ])
})

test("lan mode: fix steps come before the firewall rules, and only what is missing", () => {
  const step = M.nextStep(build({ mosh: "no", sshd: "inactive" }), [], "lan")
  assert.deepEqual(step.fixes.map(f => f.cmd).slice(0, 3), [
    "sudo pacman -S mosh", "sudo systemctl enable --now sshd",
    "sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp"
  ])
  assert.equal(step.label, "Set up in a terminal")
})

test("lan firewall: already opened for this subnet, ufw off, or ufw missing needs no step", () => {
  assert.equal(M.nextStep(build({ lan_marker: "192.168.1.0/24" }), [], "lan").kind, "pair")
  assert.equal(M.nextStep(build({ ufw: "inactive" }), [], "lan").kind, "pair")
  assert.equal(M.nextStep(build({ ufw: "missing" }), [], "lan").kind, "pair")
  // A note for a different network does not count.
  assert.equal(M.nextStep(build({ lan_marker: "10.0.0.0/24" }), [], "lan").kind, "fix")
})

test("every ufw command is scoped to a subnet; none opens to everyone or forwards ports", () => {
  const rules = M.lanRules("192.168.1.0/24")
  const all = [rules.ssh, rules.mosh, rules.sshDelete, rules.moshDelete]
  for (const cmd of all) assert.match(cmd, /^sudo ufw (delete )?allow from 192\.168\.1\.0\/24 to any port /)
  const everything = [
    ...M.firewallFixes("192.168.1.0/24"), ...M.closeFixes("192.168.1.0/24"),
    ...M.tailscaleFixes({ state: "missing" })
  ].map(f => f.cmd).join("\n")
  assert.doesNotMatch(everything, /upnp|forward|iptables|sshd_config|sudoers|ufw (disable|reset)/i)
  assert.doesNotMatch(everything, /ufw allow (22|60000)/)
})

test("close the firewall again deletes the matching rules and the note", () => {
  const fixes = M.closeFixes("192.168.1.0/24")
  assert.deepEqual(fixes.map(f => f.cmd), [
    "sudo ufw delete allow from 192.168.1.0/24 to any port 22 proto tcp",
    "sudo ufw delete allow from 192.168.1.0/24 to any port 60000:61000 proto udp",
    "rm -f ~/.local/state/pocket-pair/lan-subnet"
  ])
  const script = M.fixScript(fixes, "Pocket Pair will close the firewall again:")
  assert.match(script, /^echo 'Pocket Pair will close the firewall again:'/)
  assert.ok(script.endsWith(fixes.map(f => f.cmd).join(" && ")))
})

test("firewall command text for a firewall step is shown before it runs", () => {
  const script = M.fixScript(M.nextStep(build({}), [], "lan").fixes)
  assert.ok(script.indexOf("echo '  $ sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp'") < script.indexOf("&&"))
})

test("tailscale mode never asks for firewall changes", () => {
  const fixes = M.pendingFixes(build({ mosh: "no" }), "tailscale")
  assert.ok(!fixes.some(f => /ufw/.test(f.cmd)))
})
