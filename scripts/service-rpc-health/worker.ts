interface ServiceBinding {
  describe(): Promise<unknown>;
}

interface Env {
  PRODUCT_SERVICE: ServiceBinding;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const manifest = await env.PRODUCT_SERVICE.describe();
    return Response.json(manifest);
  },
};
