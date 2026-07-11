// Stable quality-gate parser entry point. Provider implementations remain in
// adapters/, while evaluator consumers import this path from the task contract.
export * from "./adapters/stream-parser.js";
