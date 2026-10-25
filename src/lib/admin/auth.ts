// Firebase Auth over REST (no SDK): passwordless email-link sign-in for Scott.
//   1. sendSignInLink(email)           -> accounts:sendOobCode (EMAIL_SIGNIN), link back to /admin
//   2. completeSignIn(email, oobCode)  -> accounts:signInWithEmailLink -> idToken + refreshToken
//   3. getIdToken()                    -> cached, or refreshed via securetoken.googleapis.com
// Only the refresh token and the email are kept (localStorage), never anything else.
import { ADMIN_EMAILS } from "../analytics-schema.ts";

const IDT = "https://identitytoolkit.googleapis.com/v1/accounts";
const STS = "https://securetoken.googleapis.com/v1/token";
export const STORE_REFRESH = "tritone:admin-refresh";
export const STORE_EMAIL = "tritone:admin-email";
export const STORE_PENDING = "tritone:admin-pending-email";

export const isAdminEmail = (email: string) => ADMIN_EMAILS.includes(email.trim().toLowerCase());

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Plain-English message for an Identity Toolkit / Secure Token error code. */
export function friendlyAuthError(code: string): string {
  const c = (code || "").split(" ")[0].split(":")[0].trim();
  switch (c) {
    case "OPERATION_NOT_ALLOWED":
    case "CONFIGURATION_NOT_FOUND":
      return "Sign-in isn't switched on yet in Firebase. In the Firebase console for tritone-site, open Authentication → Sign-in method, enable Email/Password with “Email link (passwordless sign-in)”, and add tritone-productions.com (and tritone-site.web.app) under Authorized domains.";
    case "INVALID_EMAIL": return "That doesn't look like an email address.";
    case "INVALID_OOB_CODE": return "That sign-in link has already been used or isn't valid. Send yourself a fresh one.";
    case "EXPIRED_OOB_CODE": return "That sign-in link has expired. Send yourself a fresh one.";
    case "USER_DISABLED": return "This account has been disabled in Firebase.";
    case "TOO_MANY_ATTEMPTS_TRY_LATER": return "Too many tries. Wait a few minutes and try again.";
    case "QUOTA_EXCEEDED": return "Firebase's daily email quota is used up. Try again tomorrow.";
    case "UNAUTHORIZED_DOMAIN": return "This website's domain isn't on Firebase's authorized list. Add it under Authentication → Settings → Authorized domains.";
    case "TOKEN_EXPIRED":
    case "INVALID_REFRESH_TOKEN":
    case "USER_NOT_FOUND":
    case "INVALID_ID_TOKEN": return "Your sign-in expired. Send yourself a new link.";
    case "API_KEY_INVALID":
    case "API key not valid. Please pass a valid API key.":
      return "The site's Firebase API key was rejected. Check PUBLIC_FEEDBACK_API_KEY at build time.";
    case "NO_KEY": return "This build has no Firebase API key (PUBLIC_FEEDBACK_API_KEY), so sign-in can't work here. Try ?demo=1 to preview.";
    case "NETWORK": return "Couldn't reach Firebase. Check the connection and try again.";
    case "NOT_ADMIN": return "That email isn't on the admin list for this dashboard.";
    default: return /api key/i.test(code) ? "The site's Firebase API key was rejected." : `Sign-in failed (${code || "unknown error"}).`;
  }
}

async function post(url: string, body: Record<string, string>, form = false): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
  } catch {
    throw new AuthError("NETWORK", friendlyAuthError("NETWORK"));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json?.error?.message ?? String(res.status);
    throw new AuthError(code, friendlyAuthError(code));
  }
  return json;
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Payload of a JWT (no verification: Firestore verifies the token server-side). */
export function jwtPayload(token: string): any {
  try {
    const b = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(atob(b + "===".slice((b.length + 3) % 4)).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function createAuth(apiKey: string) {
  let idToken = "";
  let expires = 0;
  const need = () => { if (!apiKey) throw new AuthError("NO_KEY", friendlyAuthError("NO_KEY")); };

  return {
    get email() { return store.get(STORE_EMAIL) ?? ""; },
    get signedIn() { return !!store.get(STORE_REFRESH); },
    pendingEmail: () => store.get(STORE_PENDING) ?? "",

    async sendSignInLink(email: string, continueUrl: string) {
      need();
      if (!isAdminEmail(email)) throw new AuthError("NOT_ADMIN", friendlyAuthError("NOT_ADMIN"));
      await post(`${IDT}:sendOobCode?key=${encodeURIComponent(apiKey)}`, { requestType: "EMAIL_SIGNIN", email: email.trim(), continueUrl });
      store.set(STORE_PENDING, email.trim().toLowerCase());
    },

    async completeSignIn(email: string, oobCode: string) {
      need();
      const r = await post(`${IDT}:signInWithEmailLink?key=${encodeURIComponent(apiKey)}`, { email: email.trim(), oobCode });
      const who = String(r.email ?? email).toLowerCase();
      if (!isAdminEmail(who)) throw new AuthError("NOT_ADMIN", friendlyAuthError("NOT_ADMIN"));
      idToken = r.idToken;
      expires = Date.now() + (Number(r.expiresIn) || 3600) * 1000;
      store.set(STORE_REFRESH, r.refreshToken);
      store.set(STORE_EMAIL, who);
      store.del(STORE_PENDING);
      return who;
    },

    /** A fresh ID token, refreshing it a few minutes before it expires. */
    async getIdToken(): Promise<string> {
      if (idToken && Date.now() < expires - 5 * 60e3) return idToken;
      need();
      const refresh = store.get(STORE_REFRESH);
      if (!refresh) throw new AuthError("TOKEN_EXPIRED", friendlyAuthError("TOKEN_EXPIRED"));
      try {
        const r = await post(`${STS}?key=${encodeURIComponent(apiKey)}`, { grant_type: "refresh_token", refresh_token: refresh }, true);
        idToken = r.id_token;
        expires = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        if (r.refresh_token) store.set(STORE_REFRESH, r.refresh_token);
        const em = String(jwtPayload(idToken).email ?? store.get(STORE_EMAIL) ?? "").toLowerCase();
        if (em) store.set(STORE_EMAIL, em);
        if (!isAdminEmail(em)) throw new AuthError("NOT_ADMIN", friendlyAuthError("NOT_ADMIN"));
        return idToken;
      } catch (e) {
        if (e instanceof AuthError && e.code !== "NETWORK") this.signOut();
        throw e;
      }
    },

    signOut() {
      idToken = "";
      expires = 0;
      store.del(STORE_REFRESH);
      store.del(STORE_EMAIL);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
