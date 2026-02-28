import { errorResponse } from "@/server/http/errors";
import { ok } from "@/server/http/response";
import { connectDataSource } from "@/server/services/session-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const source = await connectDataSource(body?.workspacePath);
    return ok({ source });
  } catch (error) {
    return errorResponse(error);
  }
}
