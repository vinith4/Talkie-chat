# Talkie Chat

Next.js + Supabase realtime chat.

## Setup
1. Create a Supabase project and run `supabase/migrations/0001_init.sql` in the SQL editor.
2. In Supabase Auth settings, disable "Confirm email" for quick testing (or keep it and verify by email).
3. Copy `.env.example` to `.env.local` and fill in the URL and anon key.
4. `npm install && npm run dev`

## Vercel
Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` as project environment variables, then redeploy.

## Status
Working: sign up/in, user search, direct chats, realtime messages, sign out.
WebRTC service is in `src/lib/webrtc` (call UI not yet wired).
