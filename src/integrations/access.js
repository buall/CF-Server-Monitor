import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();

export class IntegrationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// A service token is authenticated by Cloudflare, then its signed application JWT
// is verified here. A human Access session must never become an integration admin.
export async function requireShellAtlasAccess(request, env, keySet = null) {
  const team = String(env.SHELLATLAS_ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
  const audience = env.SHELLATLAS_ACCESS_AUD;
  const clientId = env.SHELLATLAS_ACCESS_CLIENT_ID;
  if (!team || !audience) {
    throw new IntegrationError('ShellAtlas Access configuration is incomplete', 503);
  }
  let issuer;
  try {
    issuer = new URL(team.includes('://') ? team : `https://${team}`);
  } catch {
    throw new IntegrationError('Invalid Access team domain', 503);
  }
  if (issuer.protocol !== 'https:' || !issuer.hostname.endsWith('.cloudflareaccess.com') ||
      issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.username || issuer.password) {
    throw new IntegrationError('Invalid Access team domain', 503);
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) throw new IntegrationError('Cloudflare Access service authentication required', 401);
  if (!keySet) {
    if (!keySets.has(issuer.origin)) {
      keySets.set(issuer.origin, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
        timeoutDuration: 5000, cooldownDuration: 30000
      }));
    }
    keySet = keySets.get(issuer.origin);
  }
  try {
    const { payload } = await jwtVerify(assertion, keySet, {
      issuer: issuer.origin, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat']
    });
    if (payload.sub !== '' || typeof payload.common_name !== 'string' || !payload.common_name.endsWith('.access') ||
        (clientId && payload.common_name !== clientId)) {
      throw new IntegrationError('This Access identity is not the ShellAtlas service', 403);
    }
    return payload;
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError('Invalid or expired Cloudflare Access assertion', 401);
  }
}
