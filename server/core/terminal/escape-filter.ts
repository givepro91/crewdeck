/**
 * 브라우저 xterm.js와 tmux pane 사이의 제어 시퀀스 왕복 위생 필터.
 *
 * 재진입 리플레이 버퍼(raw PTY 스트림)에는 이전 프로그램이 남긴 디바이스 질의(OSC 10/11
 * 색상, DA/DSR/XTVERSION)와 마우스 트래킹 enable이 들어 있다. 이를 그대로 xterm에 write하면
 * xterm이 질의에 자동 응답하고 — 그 응답이 terminal:input으로 돌아와 send-keys로 pane에
 * literal 타이핑돼 셸 프롬프트에 `10;rgb:...` 같은 junk로 echo된다 — 비정상 종료한 TUI의
 * mouse-enable이 되살아나 이후 클릭이 `0;44;7M` 같은 SGR 리포트로 입력된다.
 */

const REPLAY_QUERY_PATTERN = new RegExp(
  [
    // OSC 색상 질의: \x1b]10;? / ]11;? / ]12;? / ]4;<n>;? (BEL 또는 ST 종료)
    "\\x1b\\](?:1[012]|4;\\d+);\\?(?:\\x07|\\x1b\\\\)",
    // DA1/DA2/DA3 질의: \x1b[c \x1b[0c \x1b[>c \x1b[>0c \x1b[=c
    "\\x1b\\[[>=]?0?c",
    // DSR/CPR 질의: \x1b[5n \x1b[6n \x1b[?6n
    "\\x1b\\[\\??[56]n",
    // XTVERSION 질의: \x1b[>q \x1b[>0q
    "\\x1b\\[>0?q",
    // kitty keyboard 프로토콜 질의: \x1b[?u
    "\\x1b\\[\\?u",
    // XTGETTCAP 질의(DCS): \x1bP+q...ST
    "\\x1bP\\+q[^\\x1b]*\\x1b\\\\",
  ].join("|"),
  "g",
);

// 입력을 생성하는 DEC private 모드 — 마우스 트래킹(1000-1003, 1005/1006/1015/1016)과
// 포커스 리포팅(1004). 리플레이가 이 모드를 되살리면 이후 마우스/포커스 이벤트가
// 죽은 프로그램 대신 셸에 리포트 시퀀스로 타이핑된다.
const INPUT_GENERATING_MODES = new Set([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016]);
const DEC_MODE_SET_PATTERN = /\x1b\[\?([0-9;]+)h/g;

/** 재진입 리플레이 버퍼에서 xterm 자동 응답·입력 모드를 유발하는 시퀀스를 제거한다. */
export function sanitizeReplayOutput(data: string): string {
  if (!data.includes("\x1b")) return data;
  return data
    .replace(REPLAY_QUERY_PATTERN, "")
    .replace(DEC_MODE_SET_PATTERN, (sequence, params: string) => {
      const modes = params.split(";");
      const kept = modes.filter((mode) => !INPUT_GENERATING_MODES.has(Number(mode)));
      if (kept.length === modes.length) return sequence;
      return kept.length === 0 ? "" : `\x1b[?${kept.join(";")}h`;
    });
}

// tmux attach 클라이언트가 소비하는 응답 (실측: stdin에 써도 pane으로 새지 않음).
const FORWARDABLE_REPLY_PATTERN = new RegExp(
  [
    // OSC 색상 보고: \x1b]11;rgb:1717/1919/1d1d (BEL 또는 ST 종료)
    "\\x1b\\](?:1[012]|4;\\d+);[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    // DA 응답: \x1b[?1;2c / \x1b[>0;276;0c
    "\\x1b\\[[?>][0-9;]+c",
    // DCS 응답(XTVERSION \x1bP>|…ST, XTGETTCAP \x1bP1+r…ST)
    "\\x1bP[^\\x1b]*\\x1b\\\\",
  ].join("|"),
  "g",
);

// tmux가 소비하지 못하고 pane에 부분 포워딩하는 응답 (실측: CPR은 ";80R", kitty는 "1u"가
// 셸에 키 입력으로 샌다). pane의 CPR 질의는 tmux가 자체 응답하므로 소비자가 없다 — 폐기.
const DROPPED_REPLY_PATTERN = new RegExp(
  [
    // DSR OK 응답과 CPR: \x1b[0n / \x1b[24;80R
    "\\x1b\\[0n",
    "\\x1b\\[\\??[0-9;]+R",
    // kitty keyboard 플래그 응답: \x1b[?1u
    "\\x1b\\[\\?[0-9;]+u",
  ].join("|"),
  "g",
);

/**
 * 브라우저 입력에서 xterm이 자동 생성한 터미널 제어 응답을 키 입력과 분리한다.
 * 응답은 질의를 보낸 tmux attach 클라이언트 stdin으로 돌려주거나(tmux가 소비 가능한 것),
 * 폐기한다(send-keys로 pane에 넣으면 셸 프롬프트에 junk로 echo되므로). 나머지는
 * 실제 키 입력으로 pane에 전달한다.
 */
export function splitTerminalReplies(data: string): { replies: string; input: string } {
  if (!data.includes("\x1b")) return { replies: "", input: data };
  const replies = data.match(FORWARDABLE_REPLY_PATTERN)?.join("") ?? "";
  const input = data.replace(FORWARDABLE_REPLY_PATTERN, "").replace(DROPPED_REPLY_PATTERN, "");
  return { replies, input };
}
