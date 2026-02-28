import { errorResponse } from "@/server/http/errors";
import { ok } from "@/server/http/response";
import { getMonitoredSessionSnapshot } from "@/server/services/session-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { sourceId, sessionId } = await params;
    const snapshot = await getMonitoredSessionSnapshot(sourceId, sessionId, request.nextUrl.searchParams);
    return ok(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}
