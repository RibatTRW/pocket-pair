import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  ufw: "active", lan_routes: ROUTES, lan_addrs: addrs("wlan0", "192.168.1.16", 24), lan_subnets: "",
  ssh_conf: "PasswordAuthentication no\u001fKbdInteractiveAuthentication no", auth_keys: "2"
}

// The exact effective-policy check, written out so a change to it shows up here.
const VERIFY = '[ "$(sudo sshd -T | grep -ixcE "(passwordauthentication|kbdinteractiveauthentication) no'
  + '|pubkeyauthentication yes|authenticationmethods (any|publickey)")" = 4 ] && ' + M.SSH_MATCH
const VERIFY_FW = VERIFY + ' || { echo "SSH does not accept keys only (or a Match block touches sign-in), so the firewall was not opened."; false; }'
const DROPIN = "/etc/ssh/sshd_config.d/10-pocket-pair-keyonly.conf"

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
  const checks = build({ ts_status: "", ts_bin: "", lan_subnets: "192.168.1.0/24", ts_prefs: '{"RunSSH": true}' })
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
    VERIFY_FW,
    "sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp",
    "sudo ufw allow from 192.168.1.0/24 to any port 60000:61000 proto udp",
    "mkdir -p ~/.local/state/pocket-pair && { grep -qxF 192.168.1.0/24 ~/.local/state/pocket-pair/lan-subnets 2>/dev/null || echo 192.168.1.0/24 >> ~/.local/state/pocket-pair/lan-subnets; }"
  ])
})

test("lan mode: fix steps come before the firewall rules, and only what is missing", () => {
  const step = M.nextStep(build({ mosh: "no", sshd: "inactive" }), [], "lan")
  assert.deepEqual(step.fixes.map(f => f.cmd).slice(0, 4), [
    "sudo pacman -S mosh", "sudo systemctl enable --now sshd", VERIFY_FW,
    "sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp"
  ])
  assert.equal(step.label, "Set up in a terminal")
})

test("lan firewall: already opened for this subnet, ufw off, or ufw missing needs no step", () => {
  assert.equal(M.nextStep(build({ lan_subnets: "192.168.1.0/24" }), [], "lan").kind, "pair")
  assert.equal(M.nextStep(build({ ufw: "inactive" }), [], "lan").kind, "pair")
  assert.equal(M.nextStep(build({ ufw: "missing" }), [], "lan").kind, "pair")
  // A note for a different network does not count.
  assert.equal(M.nextStep(build({ lan_subnets: "10.0.0.0/24" }), [], "lan").kind, "fix")
})

test("every ufw command is scoped to a subnet; none opens to everyone or forwards ports", () => {
  const rules = M.lanRules("192.168.1.0/24")
  const all = [rules.ssh, rules.mosh, rules.sshDelete, rules.moshDelete]
  for (const cmd of all) assert.match(cmd, /^sudo ufw (delete )?allow from 192\.168\.1\.0\/24 to any port /)
  const everything = [
    ...M.firewallFixes("192.168.1.0/24"), ...M.closeFixes(["192.168.1.0/24"]),
    ...M.tailscaleFixes({ state: "missing" })
  ].map(f => f.cmd).join("\n")
  assert.doesNotMatch(everything.replace(M.SSH_MATCH, ""), /upnp|forward|iptables|sshd_config|sudoers|ufw (disable|reset)/i)
  assert.doesNotMatch(everything, /ufw allow (22|60000)/)
})

test("close the firewall again deletes every recorded subnet's rules and forgets each", () => {
  const fixes = M.closeFixes(["192.168.1.0/24", "192.168.50.0/24"])
  assert.deepEqual(fixes.map(f => f.cmd), [
    "sudo ufw delete allow from 192.168.1.0/24 to any port 22 proto tcp",
    "sudo ufw delete allow from 192.168.1.0/24 to any port 60000:61000 proto udp",
    'sed -i "\\|^192\\.168\\.1\\.0/24\\$|d" ~/.local/state/pocket-pair/lan-subnets',
    "sudo ufw delete allow from 192.168.50.0/24 to any port 22 proto tcp",
    "sudo ufw delete allow from 192.168.50.0/24 to any port 60000:61000 proto udp",
    'sed -i "\\|^192\\.168\\.50\\.0/24\\$|d" ~/.local/state/pocket-pair/lan-subnets'
  ])
  const script = M.fixScript(fixes, "Pocket Pair will close the firewall again:")
  assert.match(script, /^echo 'Pocket Pair will close the firewall again:'/)
  assert.ok(script.endsWith(fixes.map(f => f.cmd).join(" && ")))
})

test("the record is a real list: remember appends once, forget removes only that subnet", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-"))
  const run = cmd => execFileSync("bash", ["-c", cmd], { env: { ...process.env, HOME: dir } })
  const read = () => readFileSync(join(dir, ".local/state/pocket-pair/lan-subnets"), "utf8")
  try {
    for (const subnet of ["192.168.1.0/24", "192.168.50.0/24", "192.168.1.0/24"]) run(M.lanRules(subnet).remember)
    assert.equal(read(), "192.168.1.0/24\n192.168.50.0/24\n")
    run(M.lanRules("192.168.1.0/24").forget)
    assert.equal(read(), "192.168.50.0/24\n")
    run(M.lanRules("192.168.50.0/24").forget)
    assert.equal(read(), "")
  } finally { rmSync(dir, { recursive: true }) }
})

test("open, then switch to Tailscale: the record still offers closing it", () => {
  const checks = build({ lan_subnets: "192.168.1.0/24" })
  assert.deepEqual(checks.openSubnets, ["192.168.1.0/24"])
  assert.equal(M.nextStep(checks, [], "tailscale").kind, "pair")
  assert.deepEqual(M.closeFixes(checks.openSubnets).map(f => f.id), ["fw-ssh-close", "fw-mosh-close", "fw-note-close"])
})

test("open, then change network: the old subnet stays recorded and the new one is opened too", () => {
  const other = { lan_subnets: "192.168.1.0/24", lan_addrs: addrs("wlan0", "192.168.50.7", 24) }
  const checks = build(other)
  assert.equal(checks.firewallOpen, false)
  assert.deepEqual(checks.openSubnets, ["192.168.1.0/24"])
  const step = M.nextStep(checks, [], "lan")
  assert.equal(step.kind, "fix")
  assert.match(step.fixes[1].cmd, /from 192\.168\.50\.0\/24/)
  assert.match(step.fixes[3].cmd, />> /)
  assert.deepEqual(build({ ...other, lan_subnets: "192.168.1.0/24,192.168.50.0/24" }).openSubnets,
    ["192.168.1.0/24", "192.168.50.0/24"])
})

test("recorded subnets that are not canonical private subnets are dropped", () => {
  assert.deepEqual(M.parseSubnets("192.168.1.0/24,8.8.8.0/24,192.168.1.5/24,0.0.0.0/0,10.0.0.0/8,10.0.0.0/24;rm,x"), ["192.168.1.0/24", "10.0.0.0/8"])
  assert.deepEqual(M.parseSubnets(""), [])
})

test("firewall command text for a firewall step is shown before it runs", () => {
  const script = M.fixScript(M.nextStep(build({}), [], "lan").fixes)
  assert.ok(script.indexOf("echo '  $ sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp'") < script.indexOf(" && sudo ufw"))
})

test("tailscale mode never asks for firewall changes", () => {
  const fixes = M.pendingFixes(build({ mosh: "no" }), "tailscale")
  assert.ok(!fixes.some(f => /ufw/.test(f.cmd)))
})

// ---------------------------------------------------------------- ssh gate

const conf = (...lines) => lines.join("\u001f")
const KEYONLY = conf("PasswordAuthentication no", "KbdInteractiveAuthentication no")

test("ssh policy: key-only is proven only by both password methods off", () => {
  assert.equal(M.parseSshPolicy(KEYONLY), "keyonly")
  assert.equal(M.parseSshPolicy(conf("kbdinteractiveauthentication=no", "PASSWORDAUTHENTICATION   No")), "keyonly")
  assert.equal(M.parseSshPolicy(conf("ChallengeResponseAuthentication no", "PasswordAuthentication no")), "keyonly")
  assert.equal(M.parseSshPolicy(conf("PasswordAuthentication no # no passwords", "KbdInteractiveAuthentication no")), "keyonly")
  assert.equal(M.parseSshPolicy(conf(KEYONLY, "AuthenticationMethods publickey", "PubkeyAuthentication yes")), "keyonly")
})

test("ssh policy: stock Arch/Omarchy with no hardening has passwords on", () => {
  // Defaults: PasswordAuthentication yes. Arch's 99-archlinux.conf only turns keyboard-interactive off.
  assert.equal(M.parseSshPolicy(conf("AuthorizedKeysFile .ssh/authorized_keys", "KbdInteractiveAuthentication no", "UsePAM yes")), "password")
  assert.equal(M.parseSshPolicy(conf("PasswordAuthentication yes", "KbdInteractiveAuthentication no")), "password")
  assert.equal(M.parseSshPolicy(conf("PasswordAuthentication no")), "password")
  assert.equal(M.parseSshPolicy(conf("KbdInteractiveAuthentication no")), "password")
})

test("ssh policy: the first value wins, as in sshd", () => {
  assert.equal(M.parseSshPolicy(conf("PasswordAuthentication yes", KEYONLY)), "password")
  assert.equal(M.parseSshPolicy(conf(KEYONLY, "PasswordAuthentication yes")), "keyonly")
  assert.equal(M.parseSshPolicy(conf("ChallengeResponseAuthentication yes", "KbdInteractiveAuthentication no", "PasswordAuthentication no")), "password")
})

test("ssh policy: anything it cannot prove is not key-only", () => {
  for (const text of [
    "", undefined, "   ",
    conf(KEYONLY, "PocketPairUnresolved unreadable"),
    conf(KEYONLY, "Include /etc/ssh/more.conf"),
    conf(KEYONLY, "Match Address 192.168.0.0/16", "PasswordAuthentication yes"),
    conf(KEYONLY, "Match User bob", "AuthenticationMethods password"),
    conf(KEYONLY, "AuthenticationMethods publickey,password"),
    conf(KEYONLY, "AuthenticationMethods publickey keyboard-interactive"),
    conf(KEYONLY, "AuthenticationMethods publickey:bsdauth"),
    conf(KEYONLY, "PubkeyAuthentication no"),
    conf("PasswordAuthentication maybe", "KbdInteractiveAuthentication no"),
    conf("PasswordAuthentication", "KbdInteractiveAuthentication no"),
    conf("PasswordAuthentication no extra", "KbdInteractiveAuthentication no"),
    conf("???", KEYONLY)
  ]) assert.notEqual(M.parseSshPolicy(text), "keyonly", String(text))
  // A Match block that does not touch sign-in is harmless.
  assert.equal(M.parseSshPolicy(conf(KEYONLY, "Match User git", "AllowTcpForwarding no")), "keyonly")
})

test("ssh policy: a password method named in AuthenticationMethods reads as passwords", () => {
  assert.equal(M.parseSshPolicy(conf(KEYONLY, "AuthenticationMethods password")), "password")
})

test("authorized key counts are counts or unknown, never text", () => {
  assert.equal(M.parseKeyCount("3"), 3)
  assert.equal(M.parseKeyCount("0"), 0)
  for (const v of ["unknown", "", undefined, "-1", "ssh-ed25519 AAAA", "3 keys"]) assert.equal(M.parseKeyCount(v), -1)
})

test("check output carries the ssh keys", () => {
  const raw = M.parseCheckOutput("ssh_conf=" + KEYONLY + "\nauth_keys=2\nssh_secret=x")
  assert.deepEqual(Object.keys(raw), ["ssh_conf", "auth_keys"])
  const checks = M.buildChecks({ ...ready, ...raw }, "")
  assert.deepEqual(checks.ssh, { policy: "keyonly", keyOnly: true, keys: 2 })
})

test("gate: password or unknown policy locks the firewall and the QR behind the key-only step", () => {
  for (const ssh_conf of [conf("KbdInteractiveAuthentication no"), ""]) {
    const checks = build({ ssh_conf })
    const step = M.nextStep(checks, [], "lan")
    assert.equal(step.kind, "fix")
    assert.equal(step.label, "Make SSH keys-only")
    assert.deepEqual(step.fixes.map(f => f.id), ["ssh-conf", "ssh-test", "ssh-verify", "ssh-reload"])
    assert.ok(!step.fixes.some(f => /ufw/.test(f.cmd)), "no firewall rule before the gate passes")
    assert.equal(M.canPair(checks, "lan"), false)
    assert.equal(M.checklist(checks, "lan").find(r => r.id === "firewall").state, "wait")
    assert.equal(M.checklist(checks, "lan").find(r => r.id === "sshauth").state, "todo")
    // Already paired phones do not skip the gate either.
    assert.equal(M.nextStep(checks, [{ id: "host_x" }], "lan").kind, "fix")
  }
})

test("gate: a Match block touching sign-in is not re-offered the same step; it asks for a manual review", () => {
  const checks = build({ ssh_conf: conf(KEYONLY, "Match Address 192.168.0.0/16", "PasswordAuthentication yes") })
  assert.equal(checks.ssh.policy, "match")
  const step = M.nextStep(checks, [], "lan")
  assert.equal(step.kind, "wait")
  assert.match(step.hint, /Match block.*never edits it/)
  assert.equal(step.fixes, undefined)
  assert.equal(M.canPair(checks, "lan"), false)
  assert.equal(M.nextStep(checks, [{ id: "host_x" }], "lan").kind, "wait")
  assert.equal(M.checklist(checks, "lan").find(r => r.id === "sshauth").detail, "Match block: review by hand")
  assert.equal(M.checklist(checks, "lan").find(r => r.id === "firewall").state, "wait")
  assert.equal(M.nextStep(checks, [], "tailscale").kind, "pair")
})

test("gate: stock defaults plus a Match block touching sign-in also ask for a manual review", () => {
  const checks = build({ ssh_conf: conf("Port 22", "Match User bob", "PasswordAuthentication yes") })
  assert.equal(checks.ssh.policy, "match")
  const step = M.nextStep(checks, [], "lan")
  assert.equal(step.kind, "wait")
  assert.equal(step.fixes, undefined)
  assert.equal(M.canPair(checks, "lan"), false)
})

test("gate: verified key-only opens the firewall step, then the QR", () => {
  const checks = build({})
  assert.equal(checks.ssh.keyOnly, true)
  assert.equal(M.nextStep(checks, [], "lan").label, "Open firewall for your home network")
  assert.equal(M.canPair(checks, "lan"), true)
  assert.equal(M.nextStep(build({ lan_subnets: "192.168.1.0/24" }), [], "lan").kind, "pair")
  assert.deepEqual(M.checklist(checks, "lan").find(r => r.id === "sshauth"), { id: "sshauth", label: "SSH sign-in", state: "ok", detail: "keys only" })
})

test("gate: ufw off still needs key-only before the QR", () => {
  const checks = build({ ufw: "inactive", ssh_conf: conf("KbdInteractiveAuthentication no") })
  assert.equal(M.nextStep(checks, [], "lan").kind, "fix")
  assert.equal(M.canPair(checks, "lan"), false)
})

test("gate: Tailscale mode is untouched", () => {
  const checks = build({ ssh_conf: "" })
  assert.equal(M.nextStep(checks, [], "tailscale").kind, "pair")
  assert.equal(M.canPair(checks, "tailscale"), true)
  assert.ok(!M.checklist(checks, "tailscale").some(r => /ssh sign-in|authorized/i.test(r.label)))
  assert.ok(!M.pendingFixes(checks, "tailscale").some(f => f.id.startsWith("ssh-")))
})

test("key-only step: exact commands, in order, and before sshd is started", () => {
  const checks = build({ ssh_conf: "", sshd: "inactive", mosh: "no" })
  const step = M.nextStep(checks, [], "lan")
  assert.equal(step.label, "Set up in a terminal")
  assert.deepEqual(step.fixes.map(f => f.cmd), [
    "sudo pacman -S mosh",
    'printf "%s\\n" "# Written by Pocket Pair: SSH accepts keys only. Delete this file and run sudo systemctl reload sshd to allow passwords again."'
      + ' "PasswordAuthentication no" "KbdInteractiveAuthentication no" | sudo install -Dm644 /dev/stdin ' + DROPIN,
    "sudo sshd -t || { sudo rm -f " + DROPIN + '; echo "sshd rejected its configuration. Pocket Pair removed its file and changed nothing else."; false; }',
    VERIFY + " || { sudo rm -f " + DROPIN + '; echo "sshd is not keys only after all: an earlier rule overrides the Pocket Pair file,'
      + ' AuthenticationMethods allows more, or a Match block touches sign-in. The file was removed. Review that yourself, or use Tailscale."; false; }',
    "{ ! systemctl is-active --quiet sshd || sudo systemctl reload sshd; }",
    "sudo systemctl enable --now sshd"
  ])
  const only = M.nextStep(build({ ssh_conf: "" }), [], "lan")
  assert.equal(only.fixes.length, 4)
  assert.ok(only.fixes.findIndex(f => f.id === "ssh-test") < only.fixes.findIndex(f => f.id === "ssh-reload"), "validate before reload")
})

test("key-only step never edits the main sshd_config, sudoers, or limits/opens the firewall", () => {
  const all = [...M.keyOnlyFixes(), ...M.firewallFixes("192.168.1.0/24")].map(f => f.cmd).join("\n")
  assert.doesNotMatch(all.replaceAll(M.SSH_MATCH, ""), /sshd_config(?!\.d\/10-pocket-pair-keyonly\.conf)/)
  assert.doesNotMatch(all, /sudoers|ufw limit|ufw allow 22|ufw allow ssh/)
  for (const cmd of M.firewallFixes("192.168.1.0/24").map(f => f.cmd).filter(c => /ufw/.test(c))) assert.match(cmd, / from 192\.168\.1\.0\/24 /)
  assert.equal(M.SSH_DROPIN, DROPIN)
})

test("the firewall step checks sshd -T first, so stale panel state cannot open it", () => {
  const fixes = M.firewallFixes("192.168.1.0/24")
  assert.equal(fixes[0].cmd, VERIFY_FW)
  const script = M.fixScript(fixes)
  assert.ok(script.indexOf(VERIFY_FW + " && sudo ufw allow") > 0)
})

test("missing authorized keys: the step says nobody can sign in until the phone pairs; counts never show keys", () => {
  const none = M.nextStep(build({ ssh_conf: "", auth_keys: "0" }), [], "lan")
  assert.match(none.hint, /No keys were found in ~\/\.ssh\/authorized_keys\. Unless keys come from elsewhere \(AuthorizedKeysFile, AuthorizedKeysCommand\), nobody can sign in over SSH until your phone pairs\./)
  assert.match(none.hint, /Anyone who signs in with a password today will stop being able to\./)
  assert.match(none.hint, /Sessions already open stay connected\./)
  assert.match(M.nextStep(build({ ssh_conf: "", auth_keys: "1" }), [], "lan").hint, /1 key is already in ~\/\.ssh\/authorized_keys and keep working\./)
  assert.match(M.nextStep(build({ ssh_conf: "", auth_keys: "4" }), [], "lan").hint, /4 keys are already in/)
  assert.match(M.nextStep(build({ ssh_conf: "", auth_keys: "unknown" }), [], "lan").hint, /could not be read/)
  // sshd is off, so no one signs in with a password today.
  assert.doesNotMatch(M.nextStep(build({ ssh_conf: "", auth_keys: "0", sshd: "inactive" }), [], "lan").hint, /stop being able to/)
  const rows = key => M.checklist(build({ auth_keys: key }), "lan").find(r => r.id === "sshkeys").detail
  assert.deepEqual([rows("0"), rows("3"), rows("unknown")], ["none yet", "3 already", "not counted"])
})

test("with key-only on and no authorized keys the flow goes on to pair, which adds the phone's key", () => {
  const checks = build({ auth_keys: "0", lan_subnets: "192.168.1.0/24" })
  assert.equal(M.nextStep(checks, [], "lan").kind, "pair")
})

test("fix script prints notes first and escapes quotes in what it echoes", () => {
  const script = M.fixScript([{ cmd: 'echo "it\'s"' }], "Heading", ["A note"])
  assert.match(script, /^echo 'Heading'; echo 'A note'; echo '  \$ echo "it'\\''s"'; echo; echo "it's"$/)
  const out = execFileSync("bash", ["-c", script]).toString()
  assert.equal(out, "Heading\nA note\n  $ echo \"it's\"\n\nit's\n")
})

// ------------------------------------------------- the scripts, run for real

const FAKE_BIN_SSHD_T = `#!/bin/bash
case "$1" in
  -t) exit "\${FAKE_SSHD_T_RC:-0}" ;;
  -T) cat "$FAKE_SSHD_T_OUT" ;;
esac
`

// Runs the exact key-only commands with a stand-in sudo (no privilege, paths
// mapped under a throwaway directory), sshd and systemctl.
function runKeyOnlyFix({ effective, testRc = 0, active = true, preexisting = false, sshdConfig = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "pp-fix-"))
  const bin = join(dir, "bin")
  const write = (name, body) => { writeFileSync(join(bin, name), body, { mode: 0o755 }) }
  try {
    mkdirSync(bin)
    mkdirSync(join(dir, "etc/ssh/sshd_config.d"), { recursive: true })
    writeFileSync(join(dir, "effective"), effective)
    writeFileSync(join(dir, "etc/ssh/sshd_config"), sshdConfig)
    if (preexisting) writeFileSync(join(dir, "etc/ssh/sshd_config.d/10-pocket-pair-keyonly.conf"), "old\n")
    write("sudo", `#!/bin/bash\nshopt -s nullglob\nargs=(); for a in "$@"; do case "$a" in /etc/*) for m in ${dir}$a; do [ -e "$m" ] || [ "\${args[0]:-}" != awk ] && args+=("$m"); done;; *) args+=("$a");; esac; done\n`
      + `case "\${args[0]}" in install|rm|sshd|systemctl|awk) exec "\${args[@]}";; *) echo "unexpected sudo $*" >&2; exit 99;; esac\n`)
    write("sshd", FAKE_BIN_SSHD_T)
    write("systemctl", `#!/bin/bash\necho "systemctl $*" >> "${dir}/calls"\n`
      + `[ "$1" = is-active ] && exit ${active ? 0 : 3}\nexit 0\n`)
    const script = M.fixScript(M.keyOnlyFixes())
    let rc = 0, out = ""
    try {
      out = execFileSync("bash", ["-c", script], {
        env: { ...process.env, PATH: bin + ":" + process.env.PATH, FAKE_SSHD_T_OUT: join(dir, "effective"), FAKE_SSHD_T_RC: String(testRc) },
        stdio: ["ignore", "pipe", "pipe"]
      }).toString()
    } catch (e) { rc = e.status; out = e.stdout.toString() + e.stderr.toString() }
    const file = join(dir, "etc/ssh/sshd_config.d/10-pocket-pair-keyonly.conf")
    return {
      rc, out, exists: existsSync(file), content: existsSync(file) ? readFileSync(file, "utf8") : "",
      calls: existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : ""
    }
  } finally { rmSync(dir, { recursive: true }) }
}

const KEYONLY_T = "passwordauthentication no\nkbdinteractiveauthentication no\npubkeyauthentication yes\nauthenticationmethods any\nport 22\n"

test("key-only fix: a Match block touching sign-in fails the check, removes only Pocket Pair's file and stops", () => {
  for (const match of ["Match Address 192.168.0.0/16\n  PasswordAuthentication yes\n", "match user bob\n  AuthenticationMethods=password\n"]) {
    const r = runKeyOnlyFix({ effective: KEYONLY_T, sshdConfig: "Port 22\n" + match })
    assert.notEqual(r.rc, 0)
    assert.match(r.out, /Match block touches sign-in/)
    assert.equal(r.exists, false)
    assert.equal(r.calls, "")
  }
  const harmless = runKeyOnlyFix({ effective: KEYONLY_T, sshdConfig: "Match User git\n  AllowTcpForwarding no\n" })
  assert.equal(harmless.rc, 0, harmless.out)
})

test("key-only fix: writes the drop-in, verifies with sshd -T, then reloads a running sshd", () => {
  const r = runKeyOnlyFix({ effective: KEYONLY_T })
  assert.equal(r.rc, 0, r.out)
  assert.match(r.content, /^# Written by Pocket Pair.*\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n$/)
  assert.equal(r.calls, "systemctl is-active --quiet sshd\nsystemctl reload sshd\n")
  assert.match(r.out, /^Pocket Pair will run:\n {2}\$ printf /)
})

test("key-only fix: a stopped sshd is not reloaded (it starts with the file later)", () => {
  const r = runKeyOnlyFix({ effective: KEYONLY_T, active: false })
  assert.equal(r.rc, 0, r.out)
  assert.equal(r.calls, "systemctl is-active --quiet sshd\n")
  assert.equal(r.exists, true)
})

test("key-only fix: an effective policy that still allows passwords removes the file, says why and never reloads", () => {
  for (const effective of [
    "passwordauthentication yes\nkbdinteractiveauthentication no\npubkeyauthentication yes\nauthenticationmethods any\n",
    "passwordauthentication no\nkbdinteractiveauthentication yes\npubkeyauthentication yes\nauthenticationmethods any\n",
    "passwordauthentication no\nkbdinteractiveauthentication no\npubkeyauthentication yes\nauthenticationmethods publickey,password\n",
    "passwordauthentication no\nkbdinteractiveauthentication no\n",
    ""
  ]) {
    const r = runKeyOnlyFix({ effective, preexisting: true })
    assert.notEqual(r.rc, 0, effective)
    assert.equal(r.exists, false)
    assert.equal(r.calls, "", "no reload")
    assert.match(r.out, /sshd is not keys only after all/)
  }
})

test("key-only fix: sshd -t failing removes the file and stops before verify and reload", () => {
  const r = runKeyOnlyFix({ effective: KEYONLY_T, testRc: 1 })
  assert.notEqual(r.rc, 0)
  assert.equal(r.exists, false)
  assert.equal(r.calls, "")
  assert.match(r.out, /sshd rejected its configuration/)
})

test("firewall check passes only for a key-only sshd -T", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-fw-"))
  const bin = join(dir, "bin")
  try {
    mkdirSync(bin)
    writeFileSync(join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 })
    writeFileSync(join(bin, "sshd"), FAKE_BIN_SSHD_T, { mode: 0o755 })
    const run = effective => {
      writeFileSync(join(dir, "eff"), effective)
      try {
        // Only the first command: the ufw rules after it are never run.
        return { rc: 0, out: execFileSync("bash", ["-c", M.firewallFixes("192.168.1.0/24")[0].cmd], {
          env: { ...process.env, PATH: bin + ":" + process.env.PATH, FAKE_SSHD_T_OUT: join(dir, "eff") }, stdio: ["ignore", "pipe", "pipe"] }).toString() }
      } catch (e) { return { rc: e.status, out: e.stdout.toString() } }
    }
    assert.equal(run(KEYONLY_T).rc, 0)
    const bad = run(KEYONLY_T.replace("passwordauthentication no", "passwordauthentication yes"))
    assert.notEqual(bad.rc, 0)
    assert.match(bad.out, /firewall was not opened/)
  } finally { rmSync(dir, { recursive: true }) }
})

// scripts/read-sshd-config.sh against throwaway config trees.
function readConfig(files) {
  const dir = mkdtempSync(join(tmpdir(), "pp-ssh-"))
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true })
      writeFileSync(join(dir, name), body)
    }
    return execFileSync("bash", [join(import.meta.dirname, "../scripts/read-sshd-config.sh")], {
      env: { ...process.env, POCKET_PAIR_SSH_DIR: dir }
    }).toString().trim().split("\n").join("\u001f").replaceAll(dir, "<root>")
  } finally { rmSync(dir, { recursive: true }) }
}

test("sshd config reader expands Include in place, in sorted order, without comments", () => {
  const text = readConfig({
    "sshd_config": "# header\nInclude sshd_config.d/*.conf\n\nAuthorizedKeysFile .ssh/authorized_keys\nPasswordAuthentication yes\n",
    "sshd_config.d/99-archlinux.conf": "# arch\nKbdInteractiveAuthentication no\nUsePAM yes\n",
    "sshd_config.d/10-x.conf": "PasswordAuthentication no\n",
    "sshd_config.d/notes.txt": "PasswordAuthentication yes\n"
  })
  assert.equal(text, conf("PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM yes",
    "AuthorizedKeysFile .ssh/authorized_keys", "PasswordAuthentication yes"))
  assert.equal(M.parseSshPolicy(text), "keyonly")
})

test("sshd config reader + parser: stock Omarchy is passwords-on, hardened is key-only, odd trees are unknown", () => {
  const stock = { "sshd_config": "Include sshd_config.d/*.conf\nAuthorizedKeysFile .ssh/authorized_keys\n",
    "sshd_config.d/99-archlinux.conf": "KbdInteractiveAuthentication no\nUsePAM yes\n" }
  assert.equal(M.parseSshPolicy(readConfig(stock)), "password")
  assert.equal(M.parseSshPolicy(readConfig({ ...stock,
    "sshd_config.d/10-omarchy-hardening.conf": "PasswordAuthentication no\nKbdInteractiveAuthentication no\n" })), "keyonly")
  assert.equal(M.parseSshPolicy(readConfig({ ...stock,
    "sshd_config.d/10-pocket-pair-keyonly.conf": "# c\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n" })), "keyonly")
  // An earlier administrator rule wins over the drop-in.
  assert.equal(M.parseSshPolicy(readConfig({ ...stock,
    "sshd_config": "PasswordAuthentication yes\nInclude sshd_config.d/*.conf\n",
    "sshd_config.d/10-pocket-pair-keyonly.conf": "PasswordAuthentication no\nKbdInteractiveAuthentication no\n" })), "password")
  // A config without the Include never reads the drop-in.
  assert.equal(M.parseSshPolicy(readConfig({ "sshd_config": "UsePAM yes\n",
    "sshd_config.d/10-pocket-pair-keyonly.conf": "PasswordAuthentication no\nKbdInteractiveAuthentication no\n" })), "password")
  // No config at all, or nested includes past the limit: cannot prove anything.
  assert.equal(M.parseSshPolicy(readConfig({})), "unknown")
  assert.equal(M.parseSshPolicy(readConfig({ "sshd_config": "Include loop.conf\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n",
    "loop.conf": "Include loop.conf\n" })), "unknown")
  assert.equal(M.parseSshPolicy(readConfig({ "sshd_config": 'Include "a b.conf"\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' })), "unknown")
})

test("sshd config reader leaves an unreadable include unresolved", { skip: process.getuid && process.getuid() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-ssh-"))
  try {
    writeFileSync(join(dir, "sshd_config"), "Include a.conf\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n")
    writeFileSync(join(dir, "a.conf"), "x\n", { mode: 0o000 })
    const out = execFileSync("bash", [join(import.meta.dirname, "../scripts/read-sshd-config.sh")],
      { env: { ...process.env, POCKET_PAIR_SSH_DIR: dir } }).toString()
    assert.match(out, /^PocketPairUnresolved unreadable$/m)
    assert.equal(M.parseSshPolicy(out.split("\n").join("\u001f")), "unknown")
  } finally { rmSync(dir, { recursive: true }) }
})

// Where the machine has a real sshd, its own -T must agree with the panel's reading.
let realSshd = false
try { execFileSync("sshd", ["-V"], { stdio: "ignore" }); realSshd = true } catch (e) { realSshd = e.code !== "ENOENT" }

test("a real sshd -T agrees: the drop-in's contents give exactly the four lines the check counts", { skip: !realSshd }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-real-"))
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "hostkey")])
    mkdirSync(join(dir, "d"))
    const dropin = execFileSync("bash", ["-c", M.keyOnlyFixes()[0].cmd.replace(/^(.*?) \| sudo install.*$/, "$1")]).toString()
    const effective = d => {
      writeFileSync(join(dir, "sshd_config"), `HostKey ${dir}/hostkey\nInclude ${dir}/d/*.conf\n`)
      return execFileSync("sshd", ["-T", "-f", join(dir, "sshd_config")]).toString()
    }
    const count = out => out.split("\n").filter(l => /^((passwordauthentication|kbdinteractiveauthentication) no|pubkeyauthentication yes|authenticationmethods (any|publickey))$/i.test(l)).length
    assert.notEqual(count(effective()), 4, "stock sshd allows passwords")
    writeFileSync(join(dir, "d/10-pocket-pair-keyonly.conf"), dropin)
    assert.equal(count(effective()), 4)
  } finally { rmSync(dir, { recursive: true }) }
})
