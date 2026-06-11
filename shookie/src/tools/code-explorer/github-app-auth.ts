import jwt from "jsonwebtoken";

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_CACHE = new Map<string, CachedToken>();
const MARGIN_S = 300; // 5분 전 갱신

function buildJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 600, iss: appId },
    privateKey,
    { algorithm: "RS256" },
  );
}

async function fetchInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<CachedToken> {
  const appJwt = buildJwt(appId, privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App 토큰 획득 실패 (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = new Date(data.expires_at).getTime();

  return { token: data.token, expiresAt };
}

export async function getInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<string> {
  const cacheKey = `${appId}:${installationId}`;
  const cached = TOKEN_CACHE.get(cacheKey);

  if (cached && cached.expiresAt - MARGIN_S * 1000 > Date.now()) {
    return cached.token;
  }

  const result = await fetchInstallationToken(appId, privateKey, installationId);
  TOKEN_CACHE.set(cacheKey, result);
  return result.token;
}
