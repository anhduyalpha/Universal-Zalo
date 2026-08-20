import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { slug: string[] } }) {
  const gatewayUrl = process.env.GATEWAY_HUB_INTERNAL_URL || "http://gateway-hub:8080";
  const mediaPath = params.slug.join("/");
  const clientRange = req.headers.get("range");

  const forwardHeaders: Record<string, string> = {};
  if (clientRange) {
    forwardHeaders["Range"] = clientRange;
  }

  try {
    const res = await fetch(`${gatewayUrl}/api/media/${mediaPath}`, {
      headers: forwardHeaders,
      cache: "no-store",
    });

    if (!res.ok && res.status !== 206) {
      return new NextResponse("Media not found", { status: res.status });
    }

    const contentType = res.headers.get("Content-Type") || "application/octet-stream";
    const contentLength = res.headers.get("Content-Length");
    const contentRange = res.headers.get("Content-Range");
    const acceptRanges = res.headers.get("Accept-Ranges") || "bytes";

    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": acceptRanges,
      "Cache-Control": "public, max-age=31536000, immutable",
    };
    if (contentLength) responseHeaders["Content-Length"] = contentLength;
    if (contentRange) responseHeaders["Content-Range"] = contentRange;

    const mediaBuffer = await res.arrayBuffer();

    return new NextResponse(mediaBuffer, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (e: any) {
    return new NextResponse(`Error loading media: ${e.message}`, { status: 500 });
  }
}
