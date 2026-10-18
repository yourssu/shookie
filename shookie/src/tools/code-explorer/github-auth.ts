// Server-only credentials: never pass this provider or its configuration to a model.
import { createPrivateKey, sign } from "node:crypto";

export interface GithubTokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  redact(text: string): string;
}
interface AppSettings {
  GITHUB?: string; GITHUB_OWNER: string;
  SHOOKIE_GITHUB_APP_ID?: string;
  SHOOKIE_GITHUB_APP_INSTALLATION_ID?: string;
  SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64?: string;
}
const permissions = { metadata: "read", contents: "read", pull_requests: "read", issues: "read" };
const safeError = () => new Error("GitHub authentication unavailable");
const numeric = (v: unknown, expected: string) =>
  ((typeof v === "number" && Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9][0-9]*$/.test(v))) && String(v) === expected;
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw safeError();
  return v as Record<string, any>;
};
function readPermissions(value: unknown) {
  const p = object(value);
  if (Object.keys(p).some(k => !Object.hasOwn(permissions, k) || p[k] !== "read") ||
      Object.keys(permissions).some(k => p[k] !== "read")) throw safeError();
}

export function createGithubTokenProvider(settings: AppSettings, fetcher: typeof fetch = fetch, now = Date.now): GithubTokenProvider | undefined {
  const appId = settings.SHOOKIE_GITHUB_APP_ID ?? "";
  const installationId = settings.SHOOKIE_GITHUB_APP_INSTALLATION_ID ?? "";
  const encoded = settings.SHOOKIE_GITHUB_APP_PRIVATE_KEY_BASE64 ?? "";
  if (![appId, installationId, encoded].some(v => v.trim())) return undefined; // documented migration PAT only
  try {
    if (!/^[1-9][0-9]*$/.test(appId) || !/^[1-9][0-9]*$/.test(installationId) ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(settings.GITHUB_OWNER) || encoded.length > 32768 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw safeError();
    const pem = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.from(pem).toString("base64") !== encoded ||
        !/^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\r?\n[\s\S]+\r?\n-----END \1-----\s*$/.test(pem)) throw safeError();
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw safeError();
    const fixedSecrets = [encoded, pem, settings.GITHUB ?? ""].filter(Boolean);
    const recent: string[] = [];
    const remember = (secret: string) => { recent.push(secret); if (recent.length > 64) recent.shift(); };
    let cached: { token: string; expiry: number } | undefined;
    let pending: Promise<string> | undefined;
    const mint = async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(safeError()); }, 10000);
      });
      const work = async () => {
        const iat = Math.floor(now() / 1000) - 60;
        const head = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
        const claims = Buffer.from(JSON.stringify({ iat, exp: iat + 600, iss: appId })).toString("base64url");
        const unsigned = `${head}.${claims}`;
        const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
        remember(jwt);
        const request = async (path: string, body?: unknown) => {
          const response = await fetcher(`https://api.github.com${path}`, {
            method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
            headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (!response.ok || response.redirected || !response.body) throw safeError();
          const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.length; if (size > 65536) throw safeError(); chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        };
        const app = await request("/app");
        if (!numeric(app.id, appId)) throw safeError();
        const installation = await request(`/app/installations/${installationId}`);
        if (!numeric(installation.id, installationId) || !numeric(installation.app_id, appId) ||
            installation.target_type !== "Organization" || installation.account?.type !== "Organization" ||
            typeof installation.account?.login !== "string" ||
            installation.account.login.toLowerCase() !== settings.GITHUB_OWNER.toLowerCase() || installation.suspended_at != null) throw safeError();
        readPermissions(installation.permissions);
        const data = await request(`/app/installations/${installationId}/access_tokens`, { permissions });
        // Remember even rejected token responses, so accidentally echoed credentials remain masked.
        if (typeof data.token === "string" && data.token.length <= 4096) remember(data.token);
        readPermissions(data.permissions);
        const expiry = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
        if (typeof data.token !== "string" || !/^[A-Za-z0-9_\-.]{1,4096}$/.test(data.token) ||
            !Number.isFinite(expiry) || expiry <= now() + 60000 || expiry > now() + 3600000 + 60000) throw safeError();
        controller.signal.throwIfAborted();
        cached = { token: data.token, expiry }; return data.token;
      };
      try { return await Promise.race([work(), deadline]); }
      catch { throw safeError(); }
      finally { clearTimeout(timer); controller.abort(); }
    };
    return {
      async getToken(signal) {
        signal?.throwIfAborted();
        if (!cached || cached.expiry - now() <= 60000) {
          pending ??= mint().finally(() => { pending = undefined; });
          // Cancellation of one action must not cancel another action's shared mint.
          if (signal) {
            let listener: (() => void) | undefined;
            try { return await Promise.race([pending, new Promise<never>((_, reject) => {
              listener = () => reject(safeError()); signal.addEventListener("abort", listener, { once: true });
              if (signal.aborted) listener();
            })]); } finally { if (listener) signal.removeEventListener("abort", listener); }
          }
          return pending;
        }
        return cached.token;
      },
      redact(text) {
        const values = [...fixedSecrets, ...recent, cached?.token ?? ""].filter(Boolean).flatMap(secret =>
          [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), JSON.stringify(secret).slice(1, -1), Buffer.from(`x-access-token:${secret}`).toString("base64")]);
        for (const value of values.sort((a, b) => b.length - a.length)) text = text.split(value).join("[REDACTED]");
        return text;
      },
    };
  } catch { throw safeError(); }
}
