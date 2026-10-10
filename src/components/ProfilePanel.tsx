"use client";
import { useEffect, useRef, useState } from "react";
import { sb } from "@/lib/supabase";
import { Avatar, setCachedAvatar } from "@/components/Avatar";
import "./profile.css";

/** Crops the chosen image to a centered square and shrinks it so it can be stored with the profile. */
async function toSquareDataUrl(file: File, size = 256): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process the image");
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export function ProfilePanel({ meId, onNameChange }: { meId: string; onNameChange: (n: string) => void }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [email, setEmail] = useState("");
  const [hasPhoto, setHasPhoto] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void Promise.resolve(sb().from("profiles").select("display_name,username,bio,email,avatar_url").eq("id", meId).single()).then(({ data, error }) => {
      if (error || !data) { setErr(error?.message ?? "Could not load your profile"); setLoading(false); return; }
      const p = data as { display_name: string; username: string; bio: string | null; email: string | null; avatar_url: string | null };
      setName(p.display_name); setUsername(p.username); setBio(p.bio ?? ""); setEmail(p.email ?? ""); setHasPhoto(!!p.avatar_url);
      setLoading(false);
    });
  }, [meId]);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setErr(""); setMsg(""); setBusy(true);
    try {
      if (!f.type.startsWith("image/")) throw new Error("Please choose an image file.");
      const url = await toSquareDataUrl(f);
      const { error } = await sb().from("profiles").update({ avatar_url: url }).eq("id", meId);
      if (error) throw new Error(error.message);
      setCachedAvatar(meId, url); setHasPhoto(true); setMsg("Photo updated");
    } catch (x) { setErr(x instanceof Error ? x.message : "Could not use that image"); }
    setBusy(false);
  }

  async function removePhoto() {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb().from("profiles").update({ avatar_url: null }).eq("id", meId);
    if (error) setErr(error.message); else { setCachedAvatar(meId, null); setHasPhoto(false); setMsg("Photo removed"); }
    setBusy(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    const dn = name.trim();
    const un = username.trim().toLowerCase();
    if (!dn) return setErr("Name can't be empty.");
    if (!/^[a-z0-9_]{3,24}$/.test(un)) return setErr("Username: 3-24 characters, letters, numbers or underscore.");
    setBusy(true);
    const { error } = await sb().from("profiles").update({ display_name: dn, username: un, bio: bio.trim() }).eq("id", meId);
    setBusy(false);
    if (error) return setErr(error.code === "23505" ? "That username is already taken." : error.message);
    setUsername(un); onNameChange(dn); setMsg("Saved");
  }

  if (loading) return <p className="muted" style={{ padding: 14 }}>Loading…</p>;

  return (
    <form className="prof" onSubmit={save}>
      <div className="pavwrap">
        <Avatar userId={meId} name={name} className="pavatar" />
        <button type="button" className="camfab" onClick={() => file.current?.click()} disabled={busy} aria-label="Change profile photo">📷</button>
        <input ref={file} type="file" accept="image/*" hidden onChange={pick} />
      </div>
      {hasPhoto && <div className="row2"><button type="button" className="ghost" onClick={removePhoto} disabled={busy}>Remove photo</button></div>}
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></label>
      <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={24} autoCapitalize="none" /></label>
      <label>About<textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={140} rows={2} placeholder="Hey there! I am using Talkie" /></label>
      <label>Email<input value={email} disabled /></label>
      {err && <div className="err" role="alert">{err}</div>}
      {msg && <div className="ok" role="status">{msg}</div>}
      <button disabled={busy}>Save changes</button>
    </form>
  );
}
