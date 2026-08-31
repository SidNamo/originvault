type PendingClipboardCopy = {
  complete: (text: string) => Promise<void>;
  cancel: () => void;
};

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Older browsers and HTTP origins need the synchronous selection fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed",
    top: "0",
    left: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write was rejected");
}

export function beginClipboardCopy(): PendingClipboardCopy | undefined {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return undefined;
  let resolve: (blob: Blob) => void;
  let reject: (reason?: unknown) => void;
  const contents = new Promise<Blob>((resolveContents, rejectContents) => {
    resolve = resolveContents;
    reject = rejectContents;
  });
  let write: Promise<void>;
  try {
    write = navigator.clipboard.write([
      new ClipboardItem({ "text/plain": contents }),
    ]);
  } catch {
    return undefined;
  }
  void write.catch(() => undefined);
  return {
    complete: async (text) => {
      resolve!(new Blob([text], { type: "text/plain" }));
      await write;
    },
    cancel: () => {
      reject!(new DOMException("Share creation did not complete", "AbortError"));
      void write.catch(() => undefined);
    },
  };
}
