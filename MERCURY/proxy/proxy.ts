/**
 * Tool-Schema Proxy
 *
 * Sits between an LLM client and LLM providers.
 * On each outgoing LLM request:
 *   1. Strips full tool schemas → replaces with stubs (name + description only)
 *   2. Caches the full schemas in memory
 *   3. Injects a one-liner in the system prompt: how to fetch the full schema via web_fetch
 *
 * Serves full schemas on demand at:
 *   GET /schema/:toolName   → returns full JSON schema
 *   GET /schemas            → list all cached tool names
 *
 * Route mapping (configure the client's baseUrl to point to this proxy):
 *   POST /openrouter/*   → https://openrouter.ai/api/v1/*
 *   POST /openai/*       → https://api.openai.com/v1/*
 *   POST /anthropic/*    → https://api.anthropic.com/v1/*
 *   POST /moonshot/*     → https://api.moonshot.ai/v1/*
 *
 * Usage:
 *   npx tsx proxy.ts
 *   # or: node --import tsx/esm proxy.ts
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = 18801;
const SCHEMA_BASE_URL = `http://localhost:${PORT}/schema`;

// ─── Provider routing ─────────────────────────────────────────────────────────

const PROVIDER_ROUTES: Record<string, string> = {
  "/openrouter": "https://openrouter.ai/api/v1",
  "/openai":     "https://api.openai.com/v1",
  "/anthropic":  "https://api.anthropic.com/v1",
  "/moonshot":   "https://api.moonshot.ai/v1",
};

// ─── Schema cache (tool name → full schema object) ───────────────────────────

const schemaCache = new Map<string, unknown>();

// ─── Tool schema stripping ────────────────────────────────────────────────────

type OAITool = {
  type?: string;
  function?: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
};

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema?: unknown;
};

function stripToolsOpenAI(tools: OAITool[]): OAITool[] {
  return tools.map((tool) => {
    if (!tool.function) return tool;
    const { name, description, parameters } = tool.function;
    if (parameters) schemaCache.set(name, parameters);
    return {
      ...tool,
      function: {
        name,
        description: description ?? "",
        // Minimal passthrough schema — no properties declared
        // The model will call web_fetch /schema/:name when it needs exact params
        parameters: {
          type: "object",
          additionalProperties: true,
        },
      },
    };
  });
}

function stripToolsAnthropic(tools: AnthropicTool[]): AnthropicTool[] {
  return tools.map((tool) => {
    if (!tool.name) return tool;
    if (tool.input_schema) schemaCache.set(tool.name, tool.input_schema);
    return {
      ...tool,
      input_schema: {
        type: "object",
        additionalProperties: true,
      },
    };
  });
}

const SCHEMA_HINT =
  `Tool schemas are stripped to save tokens. ` +
  `If you need the exact parameter schema for a tool, ` +
  `use web_fetch("${SCHEMA_BASE_URL}/{tool_name}") before calling it.`;

function injectSystemPromptHint(body: Record<string, unknown>): void {
  // OpenAI format: messages[{role:"system", content:"..."}]
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const sysMsg = messages.find(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).role === "system"
    ) as Record<string, unknown> | undefined;
    if (sysMsg) {
      sysMsg.content = `${sysMsg.content}\n\n${SCHEMA_HINT}`;
    } else {
      messages.unshift({ role: "system", content: SCHEMA_HINT });
    }
  }

  // Anthropic format: system field (string or content block array)
  if (typeof body.system === "string") {
    body.system = `${body.system}\n\n${SCHEMA_HINT}`;
  } else if (Array.isArray(body.system)) {
    const block = body.system.find(
      (b: unknown) =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    if (block) {
      block.text = `${block.text}\n\n${SCHEMA_HINT}`;
    }
  }
}

function processRequestBody(
  body: Record<string, unknown>,
  isAnthropic: boolean
): Record<string, unknown> {
  const patched = { ...body };

  if (Array.isArray(patched.tools) && patched.tools.length > 0) {
    patched.tools = isAnthropic
      ? stripToolsAnthropic(patched.tools as AnthropicTool[])
      : stripToolsOpenAI(patched.tools as OAITool[]);
    injectSystemPromptHint(patched);
  }

  return patched;
}

// ─── HTTP proxy helpers ───────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function proxyToUpstream(
  targetUrl: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  res: http.ServerResponse
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...headers,
        host: url.hostname,
        "content-length": body.length.toString(),
      },
    };

    const transport = url.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(options, (upstreamRes) => {
      // Pass status + headers through
      res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      // Stream the response body directly — handles SSE/streaming natively
      upstreamRes.pipe(res);
      upstreamRes.on("end", resolve);
      upstreamRes.on("error", reject);
    });

    upstreamReq.on("error", reject);
    upstreamReq.write(body);
    upstreamReq.end();
  });
}

// ─── Main server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const path = req.url ?? "/";
  const method = req.method ?? "GET";

  // ── Schema serving ──────────────────────────────────────────────────────────
  if (method === "GET" && path.startsWith("/schema/")) {
    const toolName = decodeURIComponent(path.slice("/schema/".length));
    const schema = schemaCache.get(toolName);
    if (!schema) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Schema not found", tool: toolName }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(schema, null, 2));
    return;
  }

  if (method === "GET" && path === "/schemas") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([...schemaCache.keys()]));
    return;
  }

  // ── Provider proxy ──────────────────────────────────────────────────────────
  const providerPrefix = Object.keys(PROVIDER_ROUTES).find((p) => path.startsWith(p));
  if (!providerPrefix) {
    res.writeHead(404);
    res.end("Unknown route");
    return;
  }

  const targetBase = PROVIDER_ROUTES[providerPrefix];
  const targetPath = path.slice(providerPrefix.length) || "/";
  const targetUrl = `${targetBase}${targetPath}`;
  const isAnthropic = providerPrefix === "/anthropic";

  try {
    const rawBody = await readBody(req);

    // Only process POST requests with JSON bodies
    const contentType = req.headers["content-type"] ?? "";
    let bodyToSend = rawBody;

    if (method === "POST" && contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawBody.toString()) as Record<string, unknown>;
        const patched = processRequestBody(parsed, isAnthropic);
        bodyToSend = Buffer.from(JSON.stringify(patched));
      } catch {
        // Not valid JSON — forward as-is
      }
    }

    // Forward headers (strip host, content-length — we'll recompute)
    const forwardHeaders: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "host" || k === "content-length") continue;
      forwardHeaders[k] = v;
    }

    await proxyToUpstream(targetUrl, method, forwardHeaders, bodyToSend, res);
  } catch (err) {
    console.error("[proxy] error:", err);
    res.writeHead(502);
    res.end(JSON.stringify({ error: "Proxy error", detail: String(err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[tool-schema-proxy] listening on http://localhost:${PORT}`);
  console.log(`  Schema endpoint: GET ${SCHEMA_BASE_URL}/:toolName`);
  console.log(`  Providers: ${Object.keys(PROVIDER_ROUTES).join(", ")}`);
});
