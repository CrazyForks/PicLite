declare module "cloudflare:workers" {
  export const env: {
    DB?: unknown;
    [key: string]: unknown;
  };
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1Database {
  readonly __picliteD1Type?: "D1Database";
}
