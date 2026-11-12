// Checks that the Receipts network, manifest and actions work together, with the real
// runtime, the real page code and a scripted model. No LLM provider and no network:
// the Receipts server is replaced by a stand-in fetch.
// Run: node --test "receipts-site/tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ActionRegistry } from "../runtime/actions.js";
import { AgentNetwork, validateNetwork } from "../runtime/kernel.js";
import { runAgent } from "../runtime/runner.js";
import { TraceBus } from "../runtime/trace.js";
import { StubDocument } from "./stub_document.mjs";
import { ScriptedModel } from "./scripted_model.mjs";

const NETWORK_NAME = "receipts_desk";
const BASE = "http://localhost:8080";

/**
 * Stands in for the Receipts MCP server: a quote is "on the page" when the page text
 * below contains it.
 */
class FakeServer {
  static PAGES = { "https://example.org/pg": "PostgreSQL, also known as Postgres, is a free and open-source relational database management system." };
  static stored = new Map();

  static async fetch(url, init) {
    const msg = JSON.parse(init.body);
    const args = msg.params.arguments;
    let out;
    if (msg.params.name === "verify_quote") {
      const page = FakeServer.PAGES[args.url];
      const found = page !== undefined && page.includes(args.quote);
      const id = "rcpt_" + String(FakeServer.stored.size).padStart(20, "0");
      out = { id, url: args.url, quote: args.quote, checkedAt: "2026-11-12T00:00:00Z",
        status: page === undefined ? "unverifiable" : found ? "verified" : "rejected",
        reason: found ? "quote found on the cited page" : "quote not found on the cited page", similarity: found ? 1 : 0.2 };
      FakeServer.stored.set(id, out);
    } else {
      out = FakeServer.stored.get(args.id) || { error: "no receipt with that id" };
    }
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: out } }) };
  }
}

globalThis.document = StubDocument.fromHtml(await readFile(new URL("../index.html", import.meta.url), "utf8"));
globalThis.fetch = FakeServer.fetch;
const { registerActions } = await import("../site-actions.js");
const { App } = await import("../js/app.js");

async function setup(steps) {
  const config = JSON.parse(await readFile(new URL(`../${NETWORK_NAME}.network.json`, import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../agent-manifest.json", import.meta.url), "utf8"));
  const network = new AgentNetwork(config, NETWORK_NAME);
  const registry = new ActionRegistry();
  await registerActions({ register: registry.register.bind(registry, { base: BASE, network: NETWORK_NAME }) });
  const model = new ScriptedModel(steps);
  const ctx = {
    network, manifest, actions: registry, baseOrigin: BASE, displayOrigin: "localhost:8080", trace: new TraceBus(),
    isTop: true, frontMan: network.findFrontMan(), history: [], llm: model, confirmWebsiteActions: async () => true,
  };
  return { config, manifest, network, registry, model, ctx };
}

test("the published network is valid and names its front agent", async () => {
  const { config, network } = await setup([]);
  assert.deepEqual(validateNetwork(network).errors, []);
  assert.match(config.commondefs.replacement_strings.grounding_rules, /This site cannot:/);
  assert.equal(network.findFrontMan(), "receipts_desk");
});

test("manifest agentTools match the registered actions", async () => {
  const { manifest, registry } = await setup([]);
  const names = registry.catalog({ base: BASE, network: NETWORK_NAME }).map((a) => a.name).sort();
  assert.deepEqual(names, [...manifest.actions.agentTools].sort());
});

test("the agent checks two citations and the ledger shows both receipts", async () => {
  const { ctx, model } = await setup([
    { tool: "website_check_citation", arguments: { url: "https://example.org/pg", quote: "PostgreSQL, also known as Postgres" } },
    { tool: "website_check_citation", arguments: { url: "https://example.org/pg", quote: "Postgres was written in Rust" } },
    { tool: "website_get_ledger", arguments: {} },
    { text: "1 of 2 citations hold up." },
  ]);
  const answer = await runAgent(ctx, "receipts_desk", "check these", null);
  assert.match(JSON.stringify(answer), /1 of 2/);
  assert.ok(model.toolNames(0).includes("website_check_citation"));
  const state = App.page.readState();
  assert.deepEqual(state.counts, { verified: 1, rejected: 1, unverifiable: 0 });
  assert.equal(state.ledger[0].source, "assistant");
  // The stub keeps every appended node, so count the last render's receipts.
  const items = document.getElementById("ledger").children;
  assert.deepEqual(items.slice(-2).map((li) => li.className), ["receipt rejected", "receipt verified"]);
});

test("the site refuses a short quote and a non-http URL without calling the server", async () => {
  const before = FakeServer.stored.size;
  assert.equal((await App.page.checkCitation("ftp://x", "one two three", "assistant")).field, "url");
  assert.equal((await App.page.checkCitation("https://example.org/pg", "two words", "assistant")).field, "quote");
  assert.equal(FakeServer.stored.size, before);
});

test("a stored receipt can be looked up, and a bad id is refused", async () => {
  const id = App.page.readState().ledger[0].id;
  const found = await App.page.lookUpReceipt(id);
  assert.equal(found.ok, true);
  assert.equal(found.receipt.id, id);
  assert.equal((await App.page.lookUpReceipt("nope")).ok, false);
});

test("clearing the ledger empties the page but keeps stored receipts", async () => {
  const id = App.page.readState().ledger[0].id;
  App.page.clearLedger();
  assert.equal(App.page.readState().ledger.length, 0);
  assert.equal((await App.page.lookUpReceipt(id)).ok, true);
});
