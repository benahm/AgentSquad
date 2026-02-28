export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorResponse(error) {
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : "INTERNAL_SERVER_ERROR";
  const details = error instanceof ApiError ? error.details : null;

  return Response.json(
    {
      ok: false,
      error: {
        code,
        message: error.message || "Unexpected server error.",
        ...(details ? { details } : {}),
      },
    },
    { status }
  );
}

