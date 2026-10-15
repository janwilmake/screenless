// The live-call gate in both modes, as a table. Runs against the build:
// `npm test` builds first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, phoneRules, requestMode } from "../dist/live.js";

const cwd = "/work/project";
const bash = (command) => ["Bash", { command }];
const mcp = (name, input = {}) => [name, input];

// [tool, input, restricted, full]
const table = [
  // Reads run in both modes.
  [...["Read", { file_path: "src/index.ts" }], "allow", "allow"],
  [...["Grep", { pattern: "x" }], "allow", "allow"],
  [...bash("git log --oneline -5"), "allow", "allow"],
  [...bash("ls -la | wc -l"), "allow", "allow"],
  [...bash("ps aux"), "allow", "allow"],
  [...mcp("mcp__slack__slack_read_channel"), "allow", "allow"],
  [...mcp("mcp__linear__list_issues"), "allow", "allow"],
  [...mcp("mcp__claude_ai_Intercom__search_conversations"), "allow", "allow"],
  [...bash("agent-codemode call slack slack_read_channel --json '{\"channel\":\"C1\"}'"), "allow", "allow"],
  // Local work runs in both modes.
  [...["Edit", { file_path: "src/a.ts" }], "allow", "allow"],
  [...bash("git add -A && git commit -m wip"), "allow", "allow"],
  [...bash("npm test"), "allow", "allow"],
  // A progress note to the caller runs in both modes, as long as nothing in it runs.
  [...bash('screenless update "Still on it: the tests pass, now the logs."'), "allow", "allow"],
  [...bash("screenless update 28180e09-aaaa-bbbb-cccc-0123456789ab 'found it'"), "allow", "allow"],
  [...bash("~/.screenless/bin/screenless update 'found the bug'"), "allow", "allow"],
  [...bash('screenless update "$(cat notes.txt)"'), "deny", "allow"],
  [...bash("screenless update 'x' && git push"), "deny", "allow"],
  [...bash("screenless settings --pin 1234"), "deny", "allow"],
  // Anything that leaves the machine runs only on a proven call.
  [...bash("git push origin main"), "deny", "allow"],
  [...bash("npm run deploy"), "deny", "allow"],
  [...bash("rm -rf build"), "deny", "allow"],
  [...bash("curl -X POST https://example.com"), "deny", "allow"],
  [...bash("agent-codemode call slack slack_send_message --json '{}'"), "deny", "allow"],
  [...bash("agent-codemode call slack slack_read_channel --json '{}' | sh"), "deny", "allow"],
  [...bash("ls $(echo /)"), "deny", "allow"],
  [...mcp("mcp__slack__slack_send_message"), "deny", "allow"],
  [...mcp("mcp__linear__save_issue"), "deny", "allow"],
  [...mcp("mcp__claude-in-chrome__navigate"), "deny", "allow"],
  [...["Edit", { file_path: "/etc/hosts" }], "deny", "allow"],
  [...["NewTool", {}], "deny", "allow"],
  // Secrets never, in either mode.
  [...["Read", { file_path: ".env" }], "deny", "deny"],
  [...["Read", { file_path: "~/.ssh/id_ed25519" }], "deny", "deny"],
  [...["Read", { file_path: "/home/u/.screenless/config.json" }], "deny", "deny"],
  [...bash("cat .dev.vars"), "deny", "deny"],
  [...bash("printenv"), "deny", "deny"],
];

for (const [tool, input, restricted, full] of table) {
  const label = `${tool} ${JSON.stringify(input)}`;
  test(`restricted: ${label} → ${restricted}`, () => {
    assert.equal(decide(tool, input, cwd, "restricted").decision, restricted);
  });
  test(`full: ${label} → ${full}`, () => {
    assert.equal(decide(tool, input, cwd, "full").decision, full);
  });
}

test("no mode is restricted", () => {
  assert.equal(decide("Bash", { command: "git push" }, cwd).decision, "deny");
});

test("the fork's rules name its mode", () => {
  assert.match(phoneRules("full"), /full mode/);
  assert.match(phoneRules("restricted"), /restricted mode/);
  assert.doesNotMatch(phoneRules("restricted"), /push, deploy, and send/);
  for (const mode of ["full", "restricted"]) assert.match(phoneRules(mode), /screenless update/);
});

test("a PIN keyed mid-call makes later requests full, not earlier ones", () => {
  // A request carries the mode the call was in when it was asked.
  assert.equal(requestMode({ id: "a", request: "", context: "", mode: "restricted" }, "full"), "restricted");
  assert.equal(requestMode({ id: "b", request: "", context: "", mode: "full" }, "restricted"), "full");
  // From a Worker that does not stamp requests yet: the call's mode.
  assert.equal(requestMode({ id: "c", request: "", context: "" }, "full"), "full");
  assert.equal(requestMode({ id: "d", request: "", context: "" }, "restricted"), "restricted");
  assert.equal(requestMode({ id: "e", request: "", context: "", mode: "anything" }, "full"), "restricted");
});
