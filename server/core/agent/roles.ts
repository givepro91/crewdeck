import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("agent-roles");

export interface AgentPreset {
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  verificationLevel: "standard" | "full";
  order?: number;
}

// Resolve templates/agents/ relative to this file's location at runtime.
// __dirname is unavailable in ESM; derive it from import.meta.url instead.
// dev(server/core/agent)와 번들(dist 루트 chunk / dist/server) 각각 깊이가 달라 후보 순회.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_CANDIDATES = [
  join(__dirname, "../../../templates/agents"), // dev: server/core/agent/ → repo/templates
  join(__dirname, "../../templates/agents"),    // dist/server/ → pkg/templates
  join(__dirname, "../templates/agents"),       // dist/ 루트 chunk → pkg/templates
  join(process.cwd(), "templates/agents"),      // fallback: cwd
];
const TEMPLATES_DIR = TEMPLATE_CANDIDATES.find((p) => existsSync(p)) ?? TEMPLATE_CANDIDATES[0];

let _cache: Map<string, AgentPreset> | null = null;

function loadPresets(): Map<string, AgentPreset> {
  if (_cache) return _cache;

  const map = new Map<string, AgentPreset>();

  let files: string[];
  try {
    files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".yaml"));
  } catch (err) {
    log.warn(`Could not read templates dir ${TEMPLATES_DIR}: ${err}`);
    return map;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      const preset = parse(raw) as AgentPreset;

      if (!preset.role || !preset.systemPrompt) {
        log.warn(`Skipping ${file}: missing required fields (role, systemPrompt)`);
        continue;
      }

      map.set(preset.role, preset);
      log.info(`Loaded preset: ${preset.role} (${file})`);
    } catch (err) {
      log.warn(`Failed to parse ${file}: ${err}`);
    }
  }

  _cache = map;
  return map;
}

/** Returns all available agent presets, sorted by order field */
export function getAgentPresets(): AgentPreset[] {
  return Array.from(loadPresets().values())
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** Returns the preset for a given role, or undefined if not found */
export function getPreset(role: string): AgentPreset | undefined {
  return loadPresets().get(role);
}
