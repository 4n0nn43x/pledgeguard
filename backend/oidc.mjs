// Ledger API bearer token, shared by the web server and the registry automation. Node 22, no dependency.
// A static TOKEN (LocalNet) is used as is; otherwise the OIDC password grant of the HackCanton DevNet
// (Keycloak realm noders-appsfactory) is refreshed 30 s before it expires.

const OIDC = "https://keycloak.naas.noders.services/realms/noders-appsfactory/protocol/openid-connect/token";
const CLIENT_ID = "web-app-ui-hackcanton-01-devnet";

export function tokenProvider(env) {
  let cached = { token: env.TOKEN ?? null, until: env.TOKEN ? Infinity : 0 };
  return async function token() {
    if (Date.now() < cached.until) return cached.token;
    const res = await fetch(env.OIDC ?? OIDC, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password", client_id: env.CLIENT_ID ?? CLIENT_ID,
        username: env.DEVNET_EMAIL, password: env.DEVNET_PASSWORD,
        scope: "openid daml_ledger_api offline_access",
      }),
    });
    if (!res.ok) throw new Error(`OIDC ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    cached = { token: j.access_token, until: Date.now() + (j.expires_in - 30) * 1000 };
    return cached.token;
  };
}

// The ledger user id is the token subject on DevNet.
export const tokenSubject = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).sub;
