"use client";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import "./avatar.css";

const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** Looks up a profile photo once per user and shares it across the whole app. */
function load(id: string): Promise<string | null> {
  if (cache.has(id)) return Promise.resolve(cache.get(id) ?? null);
  let p = pending.get(id);
  if (!p) {
    p = Promise.resolve(sb().from("profiles").select("avatar_url").eq("id", id).single()).then(({ data }) => {
      const url = (data as { avatar_url: string | null } | null)?.avatar_url ?? null;
      cache.set(id, url);
      pending.delete(id);
      return url;
    });
    pending.set(id, p);
  }
  return p;
}

/** Profile photo (Gravatar / Google) with a letter fallback when the email has no photo. */
export function Avatar({ userId, name, className = "avatar" }: { userId?: string | null; name: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(userId && cache.has(userId) ? (cache.get(userId) ?? null) : null);
  const [bad, setBad] = useState(false);

  useEffect(() => {
    setBad(false);
    if (!userId) { setUrl(null); return; }
    let live = true;
    void load(userId).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [userId]);

  return (
    <span className={className}>
      {url && !bad ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
