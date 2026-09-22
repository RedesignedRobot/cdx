import { safeText } from "./safe-text.ts";

// Lives apart from safe-text.ts: the hooks project types TextDecoder without
// streaming, and hooks import only the pure text policy.
// Hold incomplete lines so UTF-8 and credentials split across chunks stay intact.
export async function* safeLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const end = pending.lastIndexOf("\n") + 1;
    if (end) yield safeText(pending.slice(0, end));
    pending = pending.slice(end);
  }
  pending += decoder.decode();
  if (pending) yield safeText(pending);
}
