import { errorResponse } from "@/server/http/errors";
import { createSessionStream } from "@/server/services/live-session-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { sourceId, sessionId } = await params;
    const stream = createSessionStream(sourceId, sessionId, request.nextUrl.searchParams);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
