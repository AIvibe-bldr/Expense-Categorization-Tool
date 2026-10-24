"use client";
import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";
export default function Login() {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState("");
  return (
    <main className="login">
      <p className="eyebrow">GALAPAGOS / EXPENSES</p>
      <h1>支出管理にログイン</h1>
      <p>管理者がSupabaseに登録したアカウントを使用してください。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
            key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
          if (!url || !key) {
            setMessage(
              "Supabase設定が必要です。ローカル検証は .env.local を設定してください。",
            );
            return;
          }
          const client = createBrowserClient(url, key);
          const { error } = await client.auth.signInWithPassword({
            email,
            password,
          });
          if (error)
            setMessage(
              "ログインできませんでした。認証情報を確認してください。",
            );
          else window.location.href = "/";
        }}
      >
        <label>
          メールアドレス
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          パスワード
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button>ログイン</button>
      </form>
      <p role="alert">{message}</p>
    </main>
  );
}
