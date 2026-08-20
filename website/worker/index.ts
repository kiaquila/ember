/**
 * Cloudflare Worker entry point for the Ember study's stage.
 *
 * The study is fully static: Workers Static Assets serves everything out of
 * `dist/`, and this Worker exists only to attach security headers, which the
 * assets pipeline does not set on its own.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/** Applied to every response, whatever it is. */
const BASELINE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // No preload: that submission is effectively irreversible for the domain.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY"
};

/**
 * The page is one self-contained file by design — its stylesheet and its
 * canvas program are inline — so `style-src` and `script-src` have to allow
 * inline sources here, unlike the sibling projects that ship separate files.
 * Everything else stays shut: the study fetches nothing, renders no input and
 * stores nothing, so there is no injection surface for the allowance to widen.
 * The build fails if the page ever gains an off-origin reference, which is the
 * property this policy actually depends on.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "upgrade-insecure-requests"
].join("; ");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);

    for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
      headers.set(name, value);
    }
    if ((headers.get("content-type") ?? "").includes("text/html")) {
      headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
