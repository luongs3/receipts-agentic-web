// Registers the Receipts page's operations with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
// Import the page script by the same URL the page uses, so there is one page state.
import { App } from "./js/app.js";

/**
 * Describes the Receipts page's operations as actions the agents can call.
 *
 * Each action wraps a ReceiptsPage method that the page's own form also uses.
 */
class SiteActions {
  /**
   * Register every site action with the runtime.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   */
  static registerActions(actions) {
    actions.register(SiteActions.readStateAction());
    actions.register(SiteActions.checkCitationAction());
    actions.register(SiteActions.lookUpReceiptAction());
    actions.register(SiteActions.clearLedgerAction());
  }

  /**
   * :return: The read action for the ledger in this tab.
   */
  static readStateAction() {
    return {
      name: "get_ledger",
      description: "Read the receipt ledger shown on this page: counts of verified, rejected and unverifiable citations, and the latest 20 receipts with id, status, reason, similarity, url, quote and the matching snippet.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => App.page.readState(),
    };
  }

  /**
   * :return: The action that checks one citation and adds its receipt to the ledger.
   */
  static checkCitationAction() {
    return {
      name: "check_citation",
      description: "Fetch the cited page on the Receipts server and check that the quoted passage appears on it. Adds a receipt to the ledger on this page and returns it: status verified (found), rejected (not on the page) or unverifiable (page could not be read), with reason, similarity 0-1 and the page snippet that matched best. Check one quote-and-URL pair per call. Returns ok false with a reason for a bad URL or a quote under 3 words.",
      // It adds a ledger entry the visitor can clear on the page; the stored receipt only
      // records the check.
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["url", "quote"],
        properties: {
          url: { type: "string", minLength: 1, maxLength: 2000, description: "The full http(s) URL the claim cites, exactly as the visitor gave it." },
          quote: { type: "string", minLength: 1, maxLength: 1000, description: "The exact passage the claim says appears on that page, copied from the visitor's text." },
        },
      },
      execute: (args) => App.page.checkCitation(args.url, args.quote, "assistant"),
    };
  }

  /**
   * :return: The read action that re-reads a stored receipt.
   */
  static lookUpReceiptAction() {
    return {
      name: "look_up_receipt",
      description: "Re-read a receipt stored on the Receipts server by its id, such as one a visitor pastes from another chat or document. Changes nothing. Returns ok false with a reason when the id is malformed or unknown.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", minLength: 1, maxLength: 40, description: "Receipt id: rcpt_ followed by 20 hex characters." } },
      },
      execute: (args) => App.page.lookUpReceipt(args.id),
    };
  }

  /**
   * :return: The action that empties this tab's ledger.
   */
  static clearLedgerAction() {
    return {
      name: "clear_ledger",
      description: "Remove every receipt from the ledger in this tab. Stored receipts stay on the server and keep their links. Use only when the visitor asks to clear the list.",
      effect: "write",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => App.page.clearLedger(),
    };
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
