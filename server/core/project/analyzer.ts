import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TechStack, AgentRole } from "../../../shared/types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("project-analyzer");

interface AnalysisResult {
  techStack: TechStack;
  suggestedAgents: Array<{ name: string; role: AgentRole; reason: string }>;
  mission: string;
  projectDocs: string[]; // file paths relative to workdir
}

/**
 * Analyze a local directory to detect tech stack and suggest agents.
 */
export function analyzeProject(dirPath: string): AnalysisResult {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const techStack: TechStack = {
    languages: [],
    frameworks: [],
    buildTool: undefined,
    testFramework: undefined,
    packageManager: undefined,
  };

  // 루트 + 1-depth 하위 디렉토리 순회 — 모노레포(web/package.json 등)의 중첩 매니페스트 인식.
  // 루트를 먼저 처리하므로 packageManager/buildTool/testFramework 단일 필드는 루트가 우선.
  const dirs = listSubDirs(dirPath);
  detectDirStack(dirPath, techStack);
  for (const sub of dirs) {
    detectDirStack(join(dirPath, sub), techStack);
  }
  if (dirs.includes("src") || dirs.includes("lib")) {
    // Standard project structure
  }
  if (dirs.includes("tests") || dirs.includes("test") || dirs.includes("__tests__")) {
    if (!techStack.testFramework) techStack.testFramework = "detected";
  }

  // Suggest agents based on tech stack
  const suggestedAgents = suggestAgents(techStack, dirs);

  // Extract mission from CLAUDE.md or readme.md
  const mission = extractMission(dirPath);

  // Detect project docs
  const projectDocs = detectProjectDocs(dirPath);

  log.info("Analysis complete", { techStack, agents: suggestedAgents.length, mission: mission.slice(0, 50) });
  return { techStack, suggestedAgents, mission, projectDocs };
}

/** 한 디렉토리의 매니페스트 파일들로 techStack을 누적 감지 (dedupe, 단일 필드는 선착순 유지) */
function detectDirStack(dirPath: string, techStack: TechStack): void {
  const files = listTopLevelFiles(dirPath);
  const addLang = (v: string) => { if (!techStack.languages.includes(v)) techStack.languages.push(v); };
  const addFw = (v: string) => { if (!techStack.frameworks.includes(v)) techStack.frameworks.push(v); };

  // Node.js / TypeScript / JavaScript
  if (files.includes("package.json")) {
    const pkg = readJsonSafe(join(dirPath, "package.json"));
    techStack.packageManager ??= files.includes("pnpm-lock.yaml")
      ? "pnpm"
      : files.includes("yarn.lock")
        ? "yarn"
        : "npm";

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };

    if (allDeps.typescript || files.includes("tsconfig.json")) {
      addLang("TypeScript");
    } else {
      addLang("JavaScript");
    }

    // Frameworks
    if (allDeps.next) addFw("Next.js");
    if (allDeps.react) addFw("React");
    if (allDeps.vue) addFw("Vue");
    if (allDeps.svelte) addFw("Svelte");
    if (allDeps.express) addFw("Express");
    if (allDeps.fastify) addFw("Fastify");
    if (allDeps["@nestjs/core"]) addFw("NestJS");
    if (allDeps.tailwindcss) addFw("TailwindCSS");

    // Build tools
    if (allDeps.vite) techStack.buildTool ??= "Vite";
    else if (allDeps.webpack) techStack.buildTool ??= "Webpack";
    else if (allDeps.tsup) techStack.buildTool ??= "tsup";

    // Test frameworks
    if (allDeps.vitest) techStack.testFramework ??= "Vitest";
    else if (allDeps.jest) techStack.testFramework ??= "Jest";
    else if (allDeps.mocha) techStack.testFramework ??= "Mocha";
  }

  // Python — requirements.txt 변형(requirements-dev.txt 등)도 인식 (D-2)
  const reqFiles = files.filter((f) => /^requirements[\w.-]*\.txt$/.test(f));
  if (reqFiles.length > 0 || files.includes("pyproject.toml") || files.includes("setup.py")) {
    addLang("Python");
    const pyManifests = [
      ...(files.includes("pyproject.toml") ? ["pyproject.toml"] : []),
      ...reqFiles,
    ];
    for (const manifest of pyManifests) {
      const content = readFileSafe(join(dirPath, manifest));
      if (content.includes("django")) addFw("Django");
      if (content.includes("fastapi")) addFw("FastAPI");
      if (content.includes("flask")) addFw("Flask");
      if (content.includes("pytest")) techStack.testFramework ??= "pytest";
    }
    techStack.packageManager ??= files.includes("poetry.lock") ? "Poetry" : "pip";
  }

  // Java / Kotlin
  if (files.includes("build.gradle") || files.includes("build.gradle.kts") || files.includes("pom.xml")) {
    if (files.includes("build.gradle.kts")) {
      addLang("Kotlin");
    } else {
      addLang("Java");
    }
    techStack.buildTool ??= files.includes("pom.xml") ? "Maven" : "Gradle";
    const content = readFileSafe(
      join(dirPath, files.includes("pom.xml") ? "pom.xml" : "build.gradle"),
    );
    if (content.includes("spring")) addFw("Spring Boot");
  }

  // Go
  if (files.includes("go.mod")) {
    addLang("Go");
    const content = readFileSafe(join(dirPath, "go.mod"));
    if (content.includes("gin")) addFw("Gin");
    if (content.includes("echo")) addFw("Echo");
  }

  // Rust
  if (files.includes("Cargo.toml")) {
    addLang("Rust");
    techStack.buildTool ??= "Cargo";
  }
}

function suggestAgents(
  techStack: TechStack,
  dirs: string[],
): Array<{ name: string; role: AgentRole; reason: string }> {
  const agents: Array<{ name: string; role: AgentRole; reason: string }> = [];

  const hasFrontend = techStack.frameworks.some((f) =>
    ["React", "Vue", "Svelte", "Next.js"].includes(f),
  );
  const hasBackend = techStack.frameworks.some((f) =>
    ["Express", "Fastify", "NestJS", "Django", "FastAPI", "Flask", "Spring Boot", "Gin"].includes(f),
  );

  if (hasFrontend && hasBackend) {
    agents.push({ name: "Frontend Dev", role: "coder", reason: `${techStack.frameworks.filter((f) => ["React", "Vue", "Svelte", "Next.js"].includes(f)).join("/")} detected` });
    agents.push({ name: "Backend Dev", role: "coder", reason: `${techStack.frameworks.filter((f) => !["React", "Vue", "Svelte", "Next.js", "TailwindCSS"].includes(f)).join("/")} detected` });
  } else {
    agents.push({ name: "Developer", role: "coder", reason: `${techStack.languages.join("/")} project` });
  }

  // Always suggest a reviewer
  agents.push({ name: "Reviewer", role: "reviewer", reason: "Quality Gate verification" });

  // QA if tests exist
  if (techStack.testFramework) {
    agents.push({ name: "QA Engineer", role: "qa", reason: `${techStack.testFramework} tests detected` });
  }

  return agents;
}

function listTopLevelFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listSubDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readJsonSafe(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Extract mission from CLAUDE.md or readme.md.
 * Looks for description lines, "## What is", or first paragraph after title.
 */
function extractMission(dirPath: string): string {
  // Try CLAUDE.md first — often has a one-liner at the top
  for (const file of ["CLAUDE.md", "README.md", "readme.md"]) {
    const content = readFileSafe(join(dirPath, file));
    if (!content) continue;

    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

    // Skip frontmatter and title, find first descriptive line
    let foundTitle = false;
    for (const line of lines) {
      if (line.startsWith("# ")) { foundTitle = true; continue; }
      if (!foundTitle) continue;
      // Skip metadata lines
      if (line.startsWith("##") || line.startsWith("```") || line.startsWith("|") || line.startsWith("-") || line.startsWith(">")) {
        // Check if it's a quote with description
        if (line.startsWith("> ") && line.length > 10) return line.slice(2).trim();
        continue;
      }
      // First normal paragraph after title
      if (line.length > 10) return line.slice(0, 200);
    }
  }
  return "";
}

/** Detect docs in project (plans, references, etc.) */
function detectProjectDocs(dirPath: string): string[] {
  const docs: string[] = [];
  const docDirs = ["docs/plans", "docs/references", "docs/reviews", "docs/designs", "docs"];
  for (const dir of docDirs) {
    const fullDir = join(dirPath, dir);
    if (!existsSync(fullDir)) continue;
    try {
      const files = readdirSync(fullDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith(".md"))
        .map((f) => `${dir}/${f.name}`);
      docs.push(...files);
    } catch { /* skip */ }
  }
  return docs;
}
