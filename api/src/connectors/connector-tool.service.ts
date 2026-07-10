import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectorsService,
  type Connector,
  type ConnectorWithAuth,
} from './connectors.service';
import { safeFetch } from '../common/safe-fetch';
import type { LlmMessage, LlmProvider } from '../rag/llm-provider';

/** Distinct system-only instruction tag used to route the tool-router call.
 * Like the answer pipeline's other *_V1 tags, this is only ever placed in a
 * `system`-role message this service constructs itself, never derived from
 * user input or KB/connector content, so nothing tenant-supplied can spoof
 * or influence router routing. */
export const TOOL_ROUTER_SYSTEM_TAG = 'BONSAI_TOOL_ROUTER_V1';

/** Max length of the rendered tool-result text handed to the answer
 * pipeline as a citable source (applies to both the templated and raw-JSON
 * fallback rendering paths). */
const MAX_RESULT_TEXT_LENGTH = 2000;

/** A live connector call's result, ready to be spliced into the answer
 * pipeline's sources as a citable, non-KB source. */
export interface ToolSource {
  text: string;
  connectorName: string;
  connectorId: string;
}

interface RouterDecision {
  connectorId: string | null;
  params: Record<string, unknown>;
}

/**
 * Routes a visitor question to at most one tenant-configured connector (see
 * ConnectorsService / api_connectors), calls it for LIVE data via
 * SSRF-guarded `safeFetch`, and renders the response into a short citable
 * text. Deliberately fails closed: ANY error anywhere in this pipeline
 * (router call, JSON parsing, network error, SSRF block, timeout) results in
 * `maybeCall` returning `null` so the caller falls back to KB-only — this
 * service must never cause an answer to be refused, and must never invent
 * data when the tool call fails.
 */
@Injectable()
export class ConnectorToolService {
  private readonly logger = new Logger(ConnectorToolService.name);

  constructor(private readonly connectors: ConnectorsService) {}

  async maybeCall(
    schemaName: string,
    projectId: string,
    question: string,
    llm: LlmProvider,
  ): Promise<ToolSource | null> {
    try {
      const available = await this.connectors.list(schemaName, projectId);
      if (available.length === 0) return null;

      const decision = await this.route(available, question, llm);
      if (!decision || decision.connectorId === null) return null;

      const connector = available.find((c) => c.id === decision.connectorId);
      if (!connector) return null;

      const withAuth = await this.connectors.getWithAuth(
        schemaName,
        connector.id,
      );

      const text = await this.callConnector(
        withAuth,
        withAuth.auth,
        decision.params,
      );
      if (!text) return null;

      return {
        text,
        connectorName: connector.name,
        connectorId: connector.id,
      };
    } catch (err) {
      this.logger.warn(
        `Tool-calling failed, falling back to KB-only: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /**
   * ROUTER: one temperature-0 LLM call presenting the available connectors
   * (name/description/usage_hint/request_schema — NEVER auth) and the
   * question, asking for ONLY a JSON object
   * `{"connectorId": "<id>"|null, "params": {..}}`. Parsed STRICTLY — any
   * parse error, non-object result, or a connectorId that isn't a string
   * (or explicit null) is treated as "no tool call" (returns null).
   */
  private async route(
    available: Connector[],
    question: string,
    llm: LlmProvider,
  ): Promise<RouterDecision | null> {
    const catalog = available.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      usageHint: c.usageHint,
      requestSchema: c.requestSchema,
    }));
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          `${TOOL_ROUTER_SYSTEM_TAG} Je routeert een klantvraag naar ` +
          'hoogstens een van de onderstaande connectors, als dat relevant ' +
          'is om de vraag te beantwoorden. Antwoord met UITSLUITEND een ' +
          'JSON-object, exact in de vorm ' +
          '{"connectorId": "<id>", "params": {...}} of ' +
          '{"connectorId": null, "params": {}} als geen enkele connector ' +
          'relevant is. Geen extra tekst. `params` moet passen bij het ' +
          '`requestSchema` van de gekozen connector.',
      },
      {
        role: 'user',
        content: `CONNECTORS:\n${JSON.stringify(catalog)}\n\nVRAAG:\n${question}`,
      },
    ];
    const raw = await llm.complete(messages, { temperature: 0 });
    return parseRouterDecision(raw);
  }

  /**
   * Builds the HTTP request from `connector.baseUrl` + `params` (GET ->
   * query string, POST -> JSON body), applies `auth` (bearer -> Authorization
   * header; header -> a single custom header; none -> no auth), calls
   * `safeFetch` (SSRF-guarded, with a timeout + size cap), and renders the
   * response into a short text via `response_template` (simple `${field}`
   * substitution over the parsed JSON body) or, failing that, the raw JSON
   * text truncated to `MAX_RESULT_TEXT_LENGTH`.
   *
   * `protected` (not `private`) so integration tests can override/spy on it
   * to inject canned live data without a real network call.
   */
  protected async callConnector(
    connector: ConnectorWithAuth,
    auth: Record<string, unknown> | null,
    params: Record<string, unknown>,
  ): Promise<string> {
    const method = connector.method === 'POST' ? 'POST' : 'GET';
    const headers: Record<string, string> = {};
    let body: string | undefined;
    let url = connector.baseUrl;

    if (method === 'GET') {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        query.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      const qs = query.toString();
      if (qs.length > 0) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(params);
    }

    applyAuth(headers, auth);

    const res = await safeFetch(url, {
      method,
      headers,
      body,
      timeoutMs: 10_000,
      maxBytes: 500_000,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = undefined;
    }

    if (connector.responseTemplate && parsed !== undefined) {
      const rendered = renderTemplate(connector.responseTemplate, parsed);
      return truncate(rendered, MAX_RESULT_TEXT_LENGTH);
    }
    return truncate(res.body, MAX_RESULT_TEXT_LENGTH);
  }
}

/** Applies the connector's decrypted `auth` object to outgoing request
 * headers: `{type:'bearer', token}` -> `Authorization: Bearer <token>`;
 * `{type:'header', name, value}` -> a single custom header; anything else
 * (including `null`/absent) applies no auth. */
function applyAuth(
  headers: Record<string, string>,
  auth: Record<string, unknown> | null,
): void {
  if (!auth) return;
  if (auth.type === 'bearer' && typeof auth.token === 'string') {
    headers.authorization = `Bearer ${auth.token}`;
  } else if (
    auth.type === 'header' &&
    typeof auth.name === 'string' &&
    typeof auth.value === 'string' &&
    auth.name.length > 0
  ) {
    headers[auth.name] = auth.value;
  }
}

/** Simple `${field}` substitution over a parsed JSON value: only supports
 * top-level field access (no nested paths), which matches the simple
 * templates connectors are expected to define. Missing fields render as an
 * empty string rather than throwing, so a partially-matching template still
 * produces useful (if incomplete) output instead of failing the whole call. */
function renderTemplate(template: string, data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return template;
  }
  const record = data as Record<string, unknown>;
  return template.replace(/\$\{(\w+)\}/g, (_match, field: string) => {
    const value = record[field];
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Strictly parses the router's response into a `RouterDecision`. Requires a
 * JSON object with a `connectorId` field that is either a non-empty string
 * or explicit `null`, and (when present) a `params` field that is a plain
 * object. ANY deviation — invalid JSON, non-object, wrong field types —
 * returns `null` (fail closed: no tool call).
 */
export function parseRouterDecision(raw: string): RouterDecision | null {
  const jsonText = extractFirstJsonObject(raw);
  if (jsonText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const connectorId = obj.connectorId;
  if (connectorId !== null && typeof connectorId !== 'string') {
    return null;
  }
  if (connectorId === null) {
    return { connectorId: null, params: {} };
  }
  if (connectorId.length === 0) return null;

  const paramsRaw = obj.params;
  const params =
    typeof paramsRaw === 'object' &&
    paramsRaw !== null &&
    !Array.isArray(paramsRaw)
      ? (paramsRaw as Record<string, unknown>)
      : {};

  return { connectorId, params };
}

/** Extracts the first top-level balanced `{...}` substring from `raw`,
 * respecting nested braces and JSON string literals. Mirrors the equivalent
 * helper in answer.service.ts. Returns null if no balanced object is found. */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
