# Supabase Accounts

1. Create a Supabase project.
2. Run the complete `supabase-schema.sql` in the project's SQL Editor. It creates the per-user saves and sequential `game_rooms` table; room IDs begin at 1000.
3. Copy the project URL and public publishable key into `supabase-config.js`.
4. Enable Email in Authentication providers. If email confirmation is enabled, set the Site URL and Redirect URLs to include the address used to run the game, such as `http://localhost:8765/**` and `https://YOUR-SERVICE.onrender.com/**`.
5. Enable Supabase Realtime for public broadcast channels.
6. Push this folder to a Git repository and create a Render Blueprint from `render.yaml`. Render uses `npm install` to build and `npm start` to run the site. The root opens `Lobby.html`; room links use `/game/1000`; `/healthz` is the service health check.
7. Create an account to host a room or start a solo season. Guests can join a public room using its number and a display name, without a password.

For local development, run `npm start`. The server binds to Render's `PORT` environment variable and listens on `0.0.0.0`.

Season saves are stored in `public.season_saves`; row-level security limits access to the signed-in user's own row. The browser also keeps a local backup for offline play. Never put a Supabase secret or service-role key in `supabase-config.js`.

The room host creates the season roster, starts the shared challenge, tallies all separate human challenge scores, and resolves council votes. Players in a room each play their own Fruit Match board. Keep the host in the game for the whole season; the room's authoritative game state runs in that browser and is broadcast to the other players.