/**
 * Server-side policy for `/api/avatars/...` routes.
 *
 * The browser only ever talks to this deployment. These functions decide,
 * on the server, which upstream hosts may be fetched and with what headers:
 * targets are pinned to two GitHub avatar hosts by exact-shape match, so no
 * request URL can ever point anywhere else, and the outbound request
 * carries nothing about the deployment or the viewer — no cookies, no
 * forwarding chain, no referrer. A failed upstream fetch maps to a plain
 * 404, which leaves the CSS background unset and the initial letter
 * underneath untouched on every client.
 */

/** GitHub logins: alphanumerics and inner hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

const GITHUB_USER_ID = /^\d{1,12}$/;

export type AvatarTarget = { kind: "login"; login: string } | { kind: "id"; id: string };

/**
 * Parse an `/api/avatars/u/{login}` or `/api/avatars/id/{id}` tail into a
 * validated upstream target, or null when the path is not one of the two
 * exact shapes this route serves.
 */
export function parseAvatarTarget(segments: string[]): AvatarTarget | null {
  if (segments.length !== 2) return null;
  const [kind, value] = segments;
  if (!kind || !value) return null;
  if (kind === "u" && GITHUB_LOGIN.test(value)) return { kind: "login", login: value };
  if (kind === "id" && GITHUB_USER_ID.test(value)) return { kind: "id", id: value };
  return null;
}

/** The upstream URL for a validated target. Nothing else is ever fetched. */
export function avatarUpstreamUrl(target: AvatarTarget): string {
  return target.kind === "login"
    ? `https://github.com/${target.login}.png?size=40`
    : `https://avatars.githubusercontent.com/u/${target.id}?v=4&size=40`;
}

/**
 * Outbound headers: deliberately fresh. No authorization, cookies, or
 * forwarding chain from the inbound request survive, and no referrer or
 * origin travels to GitHub — the request is made by the deployment server,
 * not the viewer's browser.
 */
export function avatarUpstreamHeaders(): Headers {
  const headers = new Headers({ accept: "image/*" });
  headers.delete("referer");
  headers.delete("origin");
  return headers;
}

/** Only successful image responses are forwarded; everything else fails closed. */
export function isForwardableAvatarResponse(response: Response): boolean {
  return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/");
}
