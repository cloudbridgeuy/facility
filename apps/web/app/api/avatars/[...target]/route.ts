import { avatarMode } from "@/lib/avatar-policy";
import {
  avatarUpstreamHeaders,
  avatarUpstreamUrl,
  isForwardableAvatarResponse,
  parseAvatarTarget,
} from "@/lib/avatar-proxy";

export const dynamic = "force-dynamic";

/**
 * Same-origin avatar images: `/api/avatars/u/{login}` and
 * `/api/avatars/id/{id}`. The browser never contacts GitHub; this route
 * fetches server-side with fresh, referrer-free headers and forwards only
 * successful image bytes. Any other path, an invalid target, a disabled
 * avatar mode, or an upstream failure maps to 404 — which leaves the
 * caller's CSS background unset and its initial letter showing.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ target: string[] }> },
) {
  if (avatarMode(process.env.NEXT_PUBLIC_FACILITY_AVATARS) === "off") {
    return new Response(null, { status: 404 });
  }

  const { target: segments } = await params;
  const target = parseAvatarTarget(segments ?? []);
  if (!target) return new Response(null, { status: 404 });

  try {
    const upstream = await fetch(avatarUpstreamUrl(target), {
      headers: avatarUpstreamHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!isForwardableAvatarResponse(upstream)) return new Response(null, { status: 404 });

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "image/png",
        // Avatars change rarely; let the browser and any shared cache keep
        // one for a day, and revalidate against this route afterwards.
        "cache-control": "private, max-age=86400",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
