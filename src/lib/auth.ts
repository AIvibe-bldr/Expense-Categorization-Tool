import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
export type Identity = {
  id: string;
  client: SupabaseClient | null;
  local: boolean;
  background?: boolean;
};
export async function identity(req: Request): Promise<Identity> {
  const local = process.env.GALAPAGOS_LOCAL_MODE === "1";
  if (local) {
    if (process.env.NODE_ENV === "production")
      throw Error("本番環境でローカル認証モードは使えません");
    const host = new URL(req.url).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
      throw Error("ローカルモードはループバック接続のみです");
    return {
      id: "00000000-0000-4000-8000-000000000001",
      client: null,
      local: true,
    };
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw Error("Supabase認証が未設定です");
  const jar = await cookies();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values) => {
        for (const { name, value, options } of values)
          jar.set(name, value, options);
      },
    },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw Error("UNAUTHORIZED");
  return { id: data.user.id, client, local: false };
}
export function checkOrigin(req: Request) {
  if (["GET", "HEAD"].includes(req.method)) return;
  const expected = process.env.APP_ORIGIN || new URL(req.url).origin;
  if (req.headers.get("origin") !== expected) throw Error("ORIGIN_FORBIDDEN");
}
