import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function matchesWebhookSecret(
  candidates: readonly (string | undefined)[],
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return false;
  const expectedDigest = digest(expectedSecret);
  let matched = false;

  for (const candidate of candidates) {
    const candidateDigest = digest(candidate ?? "");
    matched = timingSafeEqual(expectedDigest, candidateDigest) || matched;
  }

  return matched;
}

export function extractWebhookSecretCandidates(request: Request, body: unknown): string[] {
  const candidates: string[] = [];
  const customHeader = request.headers.get("x-webhook-secret");
  if (customHeader) candidates.push(customHeader);

  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) candidates.push(bearerMatch[1].trim());

  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const bodySecret = (body as Record<string, unknown>).secret;
    if (typeof bodySecret === "string") candidates.push(bodySecret);
  }

  return candidates;
}
