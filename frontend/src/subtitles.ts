export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

const cleanText = (value: string) =>
  value
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\N|\\n/g, "\n")
    .trim();
const normalizeNewlines = (value: string) => value.replace(/\r\n|\r/g, "\n");

const clockSeconds = (value: string): number | undefined => {
  const match = value
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?$/);
  if (!match) return undefined;
  const fraction = (match[4] ?? "0").padEnd(3, "0").slice(0, 3);
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(fraction) / 1000
  );
};

const parseTimedBlocks = (text: string): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  for (const block of normalizeNewlines(text.replace(/^\uFEFF/, "")).split(
    /\n\s*\n/,
  )) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endWithSettings] = lines[timingIndex]!.split("-->");
    const start = clockSeconds(startText ?? "");
    const end = clockSeconds(
      (endWithSettings ?? "").trim().split(/\s+/)[0] ?? "",
    );
    const cueText = cleanText(lines.slice(timingIndex + 1).join("\n"));
    if (start === undefined || end === undefined || end <= start || !cueText)
      continue;
    cues.push({ id: `cue-${cues.length}`, start, end, text: cueText });
  }
  return cues;
};

const splitAss = (value: string, columns: number): string[] => {
  const result: string[] = [];
  let remaining = value;
  for (let index = 1; index < columns; index += 1) {
    const comma = remaining.indexOf(",");
    if (comma < 0) break;
    result.push(remaining.slice(0, comma));
    remaining = remaining.slice(comma + 1);
  }
  result.push(remaining);
  return result;
};

const parseAss = (text: string): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let columns = [
    "layer",
    "start",
    "end",
    "style",
    "name",
    "marginl",
    "marginr",
    "marginv",
    "effect",
    "text",
  ];
  for (const rawLine of normalizeNewlines(text.replace(/^\uFEFF/, "")).split(
    "\n",
  )) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      columns = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((entry) => entry.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const values = splitAss(line.slice(line.indexOf(":") + 1), columns.length);
    const start = clockSeconds(values[columns.indexOf("start")] ?? "");
    const end = clockSeconds(values[columns.indexOf("end")] ?? "");
    const cueText = cleanText(values[columns.indexOf("text")] ?? "");
    if (start === undefined || end === undefined || end <= start || !cueText)
      continue;
    cues.push({ id: `cue-${cues.length}`, start, end, text: cueText });
  }
  return cues;
};

const parseLrc = (text: string, duration?: number): SubtitleCue[] => {
  const entries: Array<{ start: number; text: string }> = [];
  const normalized = normalizeNewlines(text.replace(/^\uFEFF/, ""));
  const offsetMatch = normalized.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im);
  const offset = Number(offsetMatch?.[1] ?? 0) / 1000;
  for (const line of normalized.split("\n")) {
    const timestamps = [
      ...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g),
    ];
    if (!timestamps.length) continue;
    const value = cleanText(line.replace(/\[[^\]]+\]/g, ""));
    if (!value) continue;
    for (const match of timestamps) {
      const fraction = (match[3] ?? "0").padEnd(3, "0").slice(0, 3);
      entries.push({
        start: Math.max(
          0,
          Number(match[1]) * 60 +
            Number(match[2]) +
            Number(fraction) / 1000 +
            offset,
        ),
        text: value,
      });
    }
  }
  entries.sort((left, right) => left.start - right.start);
  const merged = entries.reduce<Array<{ start: number; text: string }>>(
    (result, entry) => {
      const previous = result.at(-1);
      if (previous?.start === entry.start) {
        if (!previous.text.split("\n").includes(entry.text))
          previous.text += `\n${entry.text}`;
      } else result.push({ ...entry });
      return result;
    },
    [],
  );
  return merged.map((entry, index) => ({
    id: `cue-${index}`,
    start: entry.start,
    end:
      merged[index + 1]?.start ??
      (duration && duration > entry.start ? duration : entry.start + 5),
    text: entry.text,
  }));
};

export function parseSubtitles(
  name: string,
  text: string,
  duration?: number,
): SubtitleCue[] {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "ass" || extension === "ssa") return parseAss(text);
  if (extension === "lrc") return parseLrc(text, duration);
  return parseTimedBlocks(text);
}

const vttTime = (seconds: number) => {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
};

export function cuesToWebVtt(cues: SubtitleCue[]): string {
  return `WEBVTT\n\n${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}\n`,
    )
    .join("\n")}`;
}
