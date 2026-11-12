# Receipts — an open agentic website that checks citations

Live: https://deploytest.theodoikenh.com/oaw-receipts/

AI answers come with sources, but the quoted passage is often not on the cited page.
Receipts fetches the cited page, looks for the passage, and returns a stored, re-readable
receipt: `verified`, `rejected` (with the closest text the page really has) or
`unverifiable`.

It conforms to the [open agentic web MVP spec](https://github.com/cognizant-ai-labs/agentic-web):

| Spec piece | File |
| --- | --- |
| Public agent network (`.json`) | `receipts-site/receipts_desk.network.json` (source: `receipts_desk.hocon`) |
| Manifest + discovery | `agent-manifest.json`, `links.json`, `agent-mcp.json`, `.well-known/nsdeploy*.json` (CORS `*`) |
| Browser runtime | `receipts-site/runtime/` (nsdeploy runtime, Apache 2.0, with the agentify-website patches) |
| Interface | the chat on the page, plus the page's own form and ledger |
| LLM configuration | BYOK settings panel; a rate-limited publisher-funded model by default so visitors can try it without a key |
| Agent ↔ website | 4 `website_*` tools wrap the page's own functions (`js/app.js`): `get_ledger`, `check_citation`, `look_up_receipt`, `clear_ledger` |
| Callable by other agents | public MCP server at `/mcp`: `verify_quote(url, quote)`, `get_receipt(id)`; public receipts at `/receipt/<id>` |

## Run

```shell
LLM_KEY=<gemini key, optional> node server/server.js   # http://127.0.0.1:8823
node --test "receipts-site/tests/*.test.mjs"           # 6 tests, scripted model, no network
```

`server/server.js` (Node 22, no dependencies) serves the static site, the MCP server, the
receipt store and the optional default-model proxy.

Apache 2.0.
