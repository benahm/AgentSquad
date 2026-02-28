import { errorResponse } from "@/server/http/errors";
import { ok } from "@/server/http/response";
import { listSourceSessions } from "@/server/services/session-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  try {
    const { sourceId } = await params;
    const sessions = await listSourceSessions(sourceId);
    return ok({ sessions });
  } catch (error) {
    return errorResponse(error);
  }
}
