import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const M = createRequire(import.meta.url)("../Model.js")

const status = (backend, ips = ["100.64.0.1", "fd7a::1"]) =>
  JSON.stringify({ BackendState: backend, Self: { TailscaleIPs: ips } })

const ready = {
  hook_path: "/h/moshi-hook", hook_version: "moshi-hook version 0.4.20", daemon: "active",
  mosh: "yes", sshd: "active", ts_status: status("Running"), ts_prefs: '{"RunSSH": false}'
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
  assert.equal(M.nextStep(build({ ts_status: "" }), []).kind, "wait")
  assert.equal(M.nextStep(build({ ts_status: status("Stopped") }), []).kind, "wait")
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
