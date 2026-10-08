"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sb } from "@/lib/supabase";

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sb().auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/chat");
    });
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setInfo("");
    if (mode === "up") {
      const { data, error: err } = await sb().auth.signUp({ email, password, options: { data: { display_name: name || email.split("@")[0] } } });
      if (err) setError(err.message);
      else if (data.session) router.replace("/chat");
      else setInfo("Check your email to verify your account, then sign in.");
    } else {
      const { error: err } = await sb().auth.signInWithPassword({ email, password });
      if (err) setError(err.message); else router.replace("/chat");
    }
    setBusy(false);
  }

  async function forgot() {
    if (!email) return setError("Enter your email first.");
    const { error: err } = await sb().auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if (err) setError(err.message); else setInfo("Password reset email sent.");
  }

  return (
    <form className="auth" onSubmit={submit}>
      <h1 style={{ margin: 0 }}>Talkie</h1>
      <p className="muted" style={{ margin: 0 }}>{mode === "in" ? "Sign in to continue" : "Create your account"}</p>
      {mode === "up" && <input aria-label="Display name" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />}
      <input aria-label="Email" type="email" placeholder="Email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <input aria-label="Password" type="password" placeholder="Password (min 6)" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <div className="err" role="alert">{error}</div>}
      {info && <div className="muted" role="status">{info}</div>}
      <button disabled={busy}>{mode === "in" ? "Sign in" : "Sign up"}</button>
      <button type="button" className="ghost" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
      </button>
      {mode === "in" && <button type="button" className="ghost" onClick={forgot}>Forgot password</button>}
    </form>
  );
}
