import { ok } from "@/backend/http/response";
import { getHealthStatus } from "@/backend/services/health";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({
    health: getHealthStatus(),
  });
}
