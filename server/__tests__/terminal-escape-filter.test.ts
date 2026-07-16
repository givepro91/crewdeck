import { describe, expect, it } from "vitest";
import { sanitizeReplayOutput, splitTerminalReplies } from "../core/terminal/escape-filter.js";

describe("sanitizeReplayOutput", () => {
  it("strips device queries that would trigger xterm auto-replies", () => {
    const raw = "before\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]4;1;?\x07\x1b[c\x1b[>0c\x1b[6n\x1b[?6n\x1b[>q\x1b[?u\x1bP+q544e\x1b\\after";
    expect(sanitizeReplayOutput(raw)).toBe("beforeafter");
  });

  it("drops mouse and focus tracking enables but keeps other modes", () => {
    const raw = "\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?25h";
    expect(sanitizeReplayOutput(raw)).toBe("\x1b[?2004h\x1b[?25h");
  });

  it("filters input-generating modes out of a combined parameter list", () => {
    expect(sanitizeReplayOutput("\x1b[?1000;2004h")).toBe("\x1b[?2004h");
    expect(sanitizeReplayOutput("\x1b[?1000;1006h")).toBe("");
  });

  it("keeps disables, SGR styling, and plain text untouched", () => {
    const raw = "\x1b[?1002l\x1b[31m빨강\x1b[0m$ ls -la";
    expect(sanitizeReplayOutput(raw)).toBe(raw);
  });
});

describe("splitTerminalReplies", () => {
  it("forwards color/DA reports to the attach client and drops CPR/kitty replies", () => {
    const { replies, input } = splitTerminalReplies(
      "\x1b]11;rgb:1717/1919/1d1d\x1b\\\x1b[?1;2c\x1b[24;80R\x1b[?1uls\r",
    );
    // tmux가 소비 가능한 응답만 attach 클라이언트로 — CPR/kitty는 tmux가 pane에
    // 부분 포워딩하므로(";80R", "1u" 누출 실측) 폐기한다.
    expect(replies).toBe("\x1b]11;rgb:1717/1919/1d1d\x1b\\\x1b[?1;2c");
    expect(input).toBe("ls\r");
  });

  it("passes plain keystrokes and TUI keys through untouched", () => {
    expect(splitTerminalReplies("작업 착수\r")).toEqual({ replies: "", input: "작업 착수\r" });
    // 커서 키·마우스 리포트는 pane의 TUI가 소비해야 하는 입력이다 — 분리하지 않는다.
    expect(splitTerminalReplies("\x1b[A\x1b[<0;44;7M")).toEqual({ replies: "", input: "\x1b[A\x1b[<0;44;7M" });
  });
});
