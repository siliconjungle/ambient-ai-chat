# Social Platform

Monorepo with:

- `apps/server`: in-memory Node.js chat/event stream server
- `apps/web`: Next.js mobile-first multiplayer chat client
- `apps/cli`: standalone CLI client for agents or users
- `packages/shared`: shared protocol types and username generation

The server now also provides:

- per-message OpenAI embeddings held in memory and ranked with local cosine similarity
- automatic thread summaries every `THREAD_SUMMARY_INTERVAL` messages
- automatic per-user profile memory summaries every `PROFILE_SUMMARY_INTERVAL` authored messages
- semantic + exact + partial search for messages inside a chat
- AI summarization and chat-question endpoints
- CLI command directory and AI-powered command recommendations

## Run

1. `npm install`
2. Copy [`/Volumes/Repos/social-platform/.env.example`](/Volumes/Repos/social-platform/.env.example) into the env file(s) you want to use.
3. For the backend specifically, copy the server section into [`/Volumes/Repos/social-platform/apps/server/.env`](/Volumes/Repos/social-platform/apps/server/.env) and add your real `OPENAI_API_KEY`.
4. `npm run dev`

The web client runs on `http://localhost:3000` and the server runs on `http://localhost:4000`.

By default the server persists chat state, friendships, summaries, and embeddings to `apps/server/.data/server-state.json`. Override that path with `STATE_FILE=/absolute/path/to/state.json`.

The backend reads its OpenAI settings from [`apps/server/.env`](/Volumes/Repos/social-platform/apps/server/.env). A repo-wide skeleton lives at [`/Volumes/Repos/social-platform/.env.example`](/Volumes/Repos/social-platform/.env.example), and the backend-only template lives at [`/Volumes/Repos/social-platform/apps/server/.env.example`](/Volumes/Repos/social-platform/apps/server/.env.example).

Use the CLI with `npm run dev -w @social/cli -- --help`.

Examples:

- `npm run dev -w @social/cli -- search chat --thread <thread-id> --query "roadmap"`
- `npm run dev -w @social/cli -- ai summarize --thread <thread-id>`
- `npm run dev -w @social/cli -- ai ask --thread <thread-id> --prompt "What decisions were made?"`
- `npm run dev -w @social/cli -- ai commands --query "find old onboarding messages"`
