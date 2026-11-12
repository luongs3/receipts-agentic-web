// Receipts page: the citation check form, the receipt ledger, and the operations the
// assistant shares with them. index.html and the actions module both import this file
// by the same URL, so there is one page state.

/**
 * Talks to this site's MCP server, which fetches the cited page and stores a receipt.
 */
export class ReceiptsClient {
  /**
   * :param base: The folder that holds this page, ending in "/".
   */
  constructor(base) {
    this.endpoint = new URL("mcp", base).href;
    this.rpcId = 0;
  }

  /**
   * Call one MCP tool and return its structured result.
   *
   * :param name: The tool name.
   * :param args: The tool arguments.
   * :return: The tool's structured result.
   * :raises Error: When the server cannot be reached or returns an error.
   */
  async call(name, args) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!response.ok) {
      throw new Error(`Receipts server returned HTTP ${response.status}`);
    }
    const reply = await response.json();
    if (reply.error) {
      throw new Error(reply.error.message);
    }
    return reply.result.structuredContent;
  }
}

/**
 * The page object: state, operations, and rendering.
 */
export class ReceiptsPage {
  static EXAMPLE = {
    url: "https://en.wikipedia.org/wiki/PostgreSQL",
    quote: "PostgreSQL, also known as Postgres, is a free and open-source relational database management system",
  };

  /**
   * :param doc: The document to render into.
   * :param client: A ReceiptsClient, or a stand-in with the same call() method.
   */
  constructor(doc, client) {
    this.doc = doc;
    this.client = client;
    this.ledger = [];
    this.version = 0;
  }

  /**
   * Check that a quote and a URL are worth sending, without sending them.
   *
   * :param url: The cited page.
   * :param quote: The quoted passage.
   * :return: {ok: true} or {ok: false, reason, field}.
   */
  static checkInput(url, quote) {
    let parsed = null;
    try {
      parsed = new URL(String(url || "").trim());
    } catch {
      parsed = null;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, field: "url", reason: "Enter the full address of the cited page, starting with https://." };
    }
    const words = String(quote || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 3) {
      return { ok: false, field: "quote", reason: "Enter the quoted passage: at least 3 words." };
    }
    if (String(quote).length > 1000) {
      return { ok: false, field: "quote", reason: "The quoted passage can be at most 1000 characters." };
    }
    return { ok: true };
  }

  /**
   * Check a citation on the server and add its receipt to the ledger.
   *
   * :param url: The cited page.
   * :param quote: The quoted passage.
   * :param source: "visitor" for the form, "assistant" for the agent.
   * :return: The receipt summary, or {ok: false, reason, field}.
   */
  async checkCitation(url, quote, source) {
    const input = ReceiptsPage.checkInput(url, quote);
    if (!input.ok) {
      return input;
    }
    const receipt = await this.client.call("verify_quote", { url: String(url).trim(), quote: String(quote).trim() });
    const entry = ReceiptsPage.summarize(receipt, source);
    this.ledger.unshift(entry);
    this.version += 1;
    this.render();
    return { ok: true, receipt: entry };
  }

  /**
   * Re-read a stored receipt by id.
   *
   * :param id: The receipt id.
   * :return: The receipt summary, or {ok: false, reason}.
   */
  async lookUpReceipt(id) {
    if (!/^rcpt_[a-f0-9]{20}$/.test(String(id || ""))) {
      return { ok: false, field: "id", reason: "A receipt id looks like rcpt_ followed by 20 letters and digits." };
    }
    const receipt = await this.client.call("get_receipt", { id });
    if (receipt.error) {
      return { ok: false, field: "id", reason: "No receipt has that id." };
    }
    return { ok: true, receipt: ReceiptsPage.summarize(receipt, "lookup") };
  }

  /**
   * Remove every receipt from this tab's ledger. Stored receipts stay on the server.
   *
   * :return: The new state.
   */
  clearLedger() {
    this.ledger = [];
    this.version += 1;
    this.render();
    return this.readState();
  }

  /**
   * Return the page state as plain JSON for the assistant.
   *
   * :return: The ledger and counts.
   */
  readState() {
    const counts = { verified: 0, rejected: 0, unverifiable: 0 };
    for (const entry of this.ledger) {
      counts[entry.status] += 1;
    }
    return { version: this.version, counts: counts, ledger: this.ledger.slice(0, 20) };
  }

  /**
   * Keep the fields of a receipt that people and agents need.
   *
   * :param receipt: A receipt from the server.
   * :param source: Who asked for it.
   * :return: The summary.
   */
  static summarize(receipt, source) {
    return {
      id: receipt.id,
      status: receipt.status,
      reason: receipt.reason,
      similarity: receipt.similarity,
      url: receipt.url,
      quote: receipt.quote,
      snippet: receipt.snippet || "",
      checkedAt: receipt.checkedAt,
      link: `receipt/${receipt.id}`,
      source: source,
    };
  }

  /**
   * Draw the ledger.
   */
  render() {
    const list = this.doc.getElementById("ledger");
    const count = this.doc.getElementById("ledger-count");
    if (!list) {
      return;
    }
    list.textContent = "";
    for (const entry of this.ledger) {
      const item = this.doc.createElement("li");
      item.className = `receipt ${entry.status}`;
      const badge = { verified: "✅ verified", rejected: "❌ not on the page", unverifiable: "⚠️ could not check" }[entry.status];
      const head = this.doc.createElement("div");
      head.className = "receipt-head";
      head.textContent = `${badge} · ${Math.round((entry.similarity || 0) * 100)}% match · ${entry.source === "assistant" ? "🤖 assistant" : "you"}`;
      const quote = this.doc.createElement("blockquote");
      quote.textContent = `“${entry.quote}”`;
      const source = this.doc.createElement("a");
      source.href = entry.url;
      source.textContent = entry.url;
      source.rel = "noopener";
      const reason = this.doc.createElement("p");
      reason.className = "muted";
      reason.textContent = entry.reason;
      const link = this.doc.createElement("a");
      link.href = entry.link;
      link.className = "receipt-link";
      link.textContent = entry.id;
      item.append(head, quote, source, reason, link);
      list.append(item);
    }
    if (count) {
      count.textContent = this.ledger.length ? `${this.ledger.length} receipt${this.ledger.length === 1 ? "" : "s"}` : "No receipts yet";
    }
  }

  /**
   * Connect the form and buttons to the same operations the assistant uses.
   */
  connect() {
    const form = this.doc.getElementById("check-form");
    const error = this.doc.getElementById("check-error");
    const submit = this.doc.getElementById("check-submit");
    this.doc.getElementById("check-example").addEventListener("click", () => {
      this.doc.getElementById("check-url").value = ReceiptsPage.EXAMPLE.url;
      this.doc.getElementById("check-quote").value = ReceiptsPage.EXAMPLE.quote;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Checking…";
      try {
        const result = await this.checkCitation(
          this.doc.getElementById("check-url").value,
          this.doc.getElementById("check-quote").value,
          "visitor",
        );
        if (!result.ok) {
          error.textContent = result.reason;
          error.hidden = false;
          this.doc.getElementById(`check-${result.field}`).focus();
        }
      } catch (failure) {
        error.textContent = `The check could not run: ${failure.message}`;
        error.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = "Check the citation";
      }
    });
  }
}

/**
 * Keeps the one page object for the page, the assistant and the tests.
 */
export class App {
  static page = null;

  /**
   * Create the page object once.
   *
   * :return: The page.
   */
  static start() {
    if (!App.page) {
      const base = typeof location !== "undefined" ? new URL("../", import.meta.url).href : "http://localhost:8080/";
      App.page = new ReceiptsPage(document, new ReceiptsClient(base));
      if (typeof window !== "undefined") {
        App.page.connect();
      }
    }
    return App.page;
  }
}

App.start();
