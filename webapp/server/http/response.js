export function ok(data, init = {}) {
  return Response.json(
    {
      ok: true,
      ...data,
    },
    init
  );
}
