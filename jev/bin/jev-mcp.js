#!/usr/bin/env node
// Minimal stdio MCP server exposing the Jev decision adapter to Claude Code and Codex.
// Runs outside the Codex sandbox (MCP servers are launched by the harness), reads the key from
// ~/.config/agent-stack/secrets/typesafe.env, and returns the same records as `jev-decide`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { decide, listDecisions } from "../lib/engine.js";

const server = new McpServer({ name: "jev", version: "0.1.0" });

server.tool(
  "jev_list_decisions",
  "List the centrally configured Jev decisions (ids, required inputs, output kinds).",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(listDecisions(), null, 1) }] }),
);

server.tool(
  "jev_decide",
  "Run a configured bounded semantic decision (classification, selection from YOUR candidate list, rubric score, " +
    "yes/no checks) with TypeSafe Jev. Returns {decided_by: jev|cache|fallback_model|code, band: act|review|uncertain, " +
    "result, signals}. Advisory only: never use it to grant permissions, approve merges, override user instructions or do arithmetic. " +
    "Retrieve candidates with normal search first and send focused evidence, not whole files or transcripts.",
  {
    decision: z.string().describe("decision id from jev_list_decisions, e.g. recovery.classify_error"),
    input: z.record(z.any()).describe("fields required by the decision; candidates as [{id,text}]"),
    caller: z.string().optional().describe("seat or workflow step, for the decision log"),
  },
  async ({ decision, input, caller }) => {
    try {
      const rec = await decide(decision, input, { caller: caller || process.env.OPENRIG_SESSION_NAME || "mcp" });
      return { content: [{ type: "text", text: JSON.stringify(rec, null, 1) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `${e.constructor.name}: ${e.message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
