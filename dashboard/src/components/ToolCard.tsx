import { useState } from "react";

export interface ToolCardData {
  id: string;
  name: string;
  input: unknown;
  state: "running" | "done" | "error";
  result?: string;
}

function summarize(_name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const target = i.file_path ?? i.path ?? i.command ?? i.pattern ?? "";
  return String(target);
}

export function ToolCard({ data }: { data: ToolCardData }) {
  const [open, setOpen] = useState(false);
  const statusChip = {
    running: "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/10",
    done: "text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-500/10",
    error: "text-red-500 bg-red-50 dark:text-red-400 dark:bg-red-500/10",
  }[data.state];
  const statusLabel = { running: "running", done: "done", error: "error" }[data.state];

  return (
    <div className="border border-gray-100 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-700/40"
      >
        <span className="font-mono font-bold">{data.name}</span>
        <span className="font-mono text-gray-400 dark:text-gray-500 truncate flex-1 min-w-0">
          {summarize(data.name, data.input)}
        </span>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${statusChip}`}>
          {statusLabel}
        </span>
        <span className="text-gray-400 text-[10px]">{open ? "▼" : "▶"}</span>
      </button>
      {open && (
        <pre className="border-t border-gray-100 dark:border-gray-700 px-3 py-2 text-[11px] font-mono text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words bg-gray-50 dark:bg-gray-900/40 m-0">
{data.result ?? JSON.stringify(data.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
