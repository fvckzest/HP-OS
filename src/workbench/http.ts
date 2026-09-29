import { checkWorkbenchRequest } from "./environment";

export function guardWorkbenchRequest(request: Request, mutation = false): Response | null {
  const result = checkWorkbenchRequest(request, { mutation });
  if (result.allowed) return null;
  return Response.json({ error: result.message }, { status: result.status });
}

export async function readBoundedText(request: Request, maximumBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("request_too_large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
