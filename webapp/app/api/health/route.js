import { ok } from "@/server/http/response";
import { getHealthStatus } from "@/server/services/health";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({
    health: getHealthStatus(),
  });
}
