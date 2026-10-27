# Supabase Accounts

1. Create a Supabase project.
2. Run the complete `supabase-schema.sql` in the project's SQL Editor. It creates the per-user saves and sequential `game_rooms` table; room IDs begin at 1000.
3. Copy the project URL and public publishable key into `supabase-config.js`.
4. Enable Email in Authentication providers. If email confirmation is enabled, set the Site URL and Redirect URLs to include the address used to run the game, such as `http://localhost:8765/**` and `https://YOUR-SERVICE.onrender.com/**`.
5. Enable Supabase Realtime for public broadcast channels.
6. Push this folder to a Git repository and create a Render Blueprint from `render.yaml`. Render uses `npm install` to build and `npm start` to run the site. The root opens `Lobby.html`; room links use `/game/1000`; `/healthz` is the service health check.
7. Create an account to host a room. Press `Join game` to join the oldest waiting room, or to create the next room if none is open. Hosts can wait for another player and choose `Start with players`, or choose `Fill with bots` to start with a full cast. Anyone can join an open room without a password.

If the Render service is a **Static Site**, open its **Settings → Redirects/Rewrites** and add a rule with source `/game/*`, destination `/index.html`, and action **Rewrite**. Render does not use this repository's Netlify `_redirects` file. If you deploy as the Node Web Service defined by `render.yaml`, `server.js` handles `/game/<id>` directly instead.

For local development, run `npm start`. The server binds to Render's `PORT` environment variable and listens on `0.0.0.0`.

Season saves are stored in `public.season_saves`; row-level security limits access to the signed-in user's own row. The browser also keeps a local backup for offline play. Never put a Supabase secret or service-role key in `supabase-config.js`.

Account usernames are stored in Supabase Auth user metadata as `display_name`. New users choose one during sign-up; existing users can change theirs from the signed-in lobby panel. Room presence and cast lists use that username.

The room host creates the season roster, starts the shared challenge, tallies all separate human challenge scores, and resolves council votes. Players in a room each play their own Fruit Match board. Keep the host in the game for the whole season; the room's authoritative game state runs in that browser and is broadcast to the other players.