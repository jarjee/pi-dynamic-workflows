/**
 * Models Browser Extension
 *
 * Exposes the contents of `~/.pi/agent/models.json` to the LLM via two
 * custom tools:
 *
 *   - `list_models`  — return the full models.json object (providers → models)
 *   - `get_model`    — substring search across provider/model id+name,
 *                      returns matching entries with their provider attached
 *
 * The file is read fresh on every call so in-session edits to models.json
 * are reflected immediately (pi itself reloads the file on each /model open).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");

/** Shape of a single model entry in models.json (subset we surface). */
type RawModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  [key: string]: unknown;
};

type ModelsJson = {
  providers?: Record<
    string,
    {
      name?: string;
      baseUrl?: string;
      api?: string;
      models?: RawModel[];
      [key: string]: unknown;
    }
  >;
};

/** Read + parse models.json. Throws on missing/unreadable/invalid JSON. */
function loadModelsJson(): ModelsJson {
  const raw = readFileSync(MODELS_JSON_PATH, "utf8");
  return JSON.parse(raw) as ModelsJson;
}

/** Flattened, provider-tagged model entry returned by `get_model`. */
type FlatModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  input: string[] | undefined;
  cost: RawModel["cost"];
};

/** Flatten all provider/model pairs into a single list. */
function flattenModels(config: ModelsJson): Array<FlatModel> {
  const out: Array<FlatModel> = [];
  for (const [providerKey, provider] of Object.entries(config.providers ?? {})) {
    for (const model of provider.models ?? []) {
      out.push({
        provider: providerKey,
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning ?? false,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        cost: model.cost,
      });
    }
  }
  return out;
}

/** Case-insensitive substring test. */
function matches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export default function modelsBrowserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_models",
    label: "List Models",
    description:
      "Return the full contents of ~/.pi/agent/models.json — every provider (baseUrl, api, compat) and the models declared under each. Use to inspect what custom models/providers are configured. Does not include pi's built-in models.",
    promptSnippet: "Dump the full models.json provider/model configuration",
    promptGuidelines: [
      "Use list_models when the user asks what models or providers are configured in models.json, or wants to see baseUrl/api/compat settings.",
    ],
    parameters: Type.Object({
      provider: Type.Optional(
        Type.String({
          description: "Optional provider key (e.g. 'openai', 'anthropic') to return only that provider's block.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      let config: ModelsJson;
      try {
        config = loadModelsJson();
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to read models.json at ${MODELS_JSON_PATH}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }

      const providers = config.providers ?? {};
      const result =
        params.provider === undefined || params.provider === ""
          ? config
          : { providers: { [params.provider]: providers[params.provider] ?? null } };

      const text = JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          path: MODELS_JSON_PATH,
          providerFilter: params.provider ?? null,
          providerCount: Object.keys(providers).length,
        },
      };
    },
  });

  pi.registerTool({
    name: "get_model",
    label: "Get Model",
    description:
      "Substring search across configured models.json entries. Searches provider key, provider display name, model id, and model name (case-insensitive). Returns matching models with provider, context window, cost, reasoning flag, and input modalities. Use to look up a model's details by partial name.",
    promptSnippet: "Look up configured models by substring match on id/name/provider",
    promptGuidelines: [
      "Use get_model when the user asks about a specific model or family by name (e.g. 'gpt-5.6', 'kimi', 'sonnet') to fetch its config from models.json.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Substring to search for across provider key/name and model id/name (case-insensitive).",
      }),
      provider: Type.Optional(
        Type.String({
          description: "Optional provider key to restrict the search to one provider (e.g. 'anthropic').",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max number of matches to return (default 50).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      let config: ModelsJson;
      try {
        config = loadModelsJson();
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to read models.json at ${MODELS_JSON_PATH}: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }

      const query = params.query?.trim() ?? "";
      if (query === "") {
        return {
          content: [
            {
              type: "text" as const,
              text: "get_model requires a non-empty 'query' substring.",
            },
          ],
          isError: true,
        };
      }

      const limit = params.limit && params.limit > 0 ? params.limit : 50;
      const providerFilter = params.provider === undefined || params.provider === "" ? null : params.provider;

      const all = flattenModels(config).filter((m) => {
        if (providerFilter && m.provider !== providerFilter) return false;
        return matches(m.provider, query) || matches(m.id, query) || matches(m.name, query);
      });

      const truncated = all.length > limit;
      const results = truncated ? all.slice(0, limit) : all;

      const payload = {
        query,
        providerFilter,
        matchCount: all.length,
        returned: results.length,
        truncated,
        models: results,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: {
          query,
          providerFilter,
          matchCount: all.length,
          truncated,
        },
      };
    },
  });
}
