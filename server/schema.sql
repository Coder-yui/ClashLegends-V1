CREATE TABLE IF NOT EXISTS guests (
    id text PRIMARY KEY, token text NOT NULL UNIQUE, name text NOT NULL,
    last_seen timestamptz NOT NULL DEFAULT now(), last_preset text
);
CREATE TABLE IF NOT EXISTS presets (
    id text PRIMARY KEY, owner_id text NOT NULL REFERENCES guests(id), name text NOT NULL,
    deck jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rooms (
    id text PRIMARY KEY, code text NOT NULL UNIQUE, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    guest_id text PRIMARY KEY REFERENCES guests(id), room_id text NOT NULL REFERENCES rooms(id)
);
CREATE INDEX IF NOT EXISTS member_room ON members(room_id);
CREATE TABLE IF NOT EXISTS matches (
    id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id), round integer NOT NULL,
    config jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','withdrawn','claimed')),
    UNIQUE(room_id, round)
);

-- The match host claims one frozen handoff. Concurrent claims or
-- withdrawn matches return zero rows. This function is server-side only.
CREATE OR REPLACE FUNCTION claim_pending_match(match_key text)
RETURNS SETOF jsonb LANGUAGE sql AS $$
    UPDATE matches SET status='claimed'
    WHERE id=match_key AND status='pending'
    RETURNING config
$$;

-- Host checkpoints use the frozen seed and the ordered human input log.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS battle_tick integer NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS inputs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE matches ADD COLUMN IF NOT EXISTS result jsonb;

CREATE TABLE IF NOT EXISTS account_data (
    player text PRIMARY KEY REFERENCES guests(id),
    fields jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS account_sessions (
    token text PRIMARY KEY,
    player text NOT NULL REFERENCES account_data(player),
    expires_at timestamptz NOT NULL
);
