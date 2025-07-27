import "dotenv/config";
import SpotifyWebApi from "spotify-web-api-node";
import { setTimeout as sleep } from "node:timers/promises";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  SPOTIFY_REDIRECT_URI = "http://localhost:3000/callback",
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN) {
  throw new Error("Missing Spotify credentials in .env");
}

export const spotify = new SpotifyWebApi({
  clientId: SPOTIFY_CLIENT_ID,
  clientSecret: SPOTIFY_CLIENT_SECRET,
  redirectUri: SPOTIFY_REDIRECT_URI,
});
spotify.setRefreshToken(SPOTIFY_REFRESH_TOKEN);

async function ensureAccessToken() {
  const token = spotify.getAccessToken();
  if (token) return;
  const data = await spotify.refreshAccessToken();
  spotify.setAccessToken(data.body.access_token);
}

/** Basic retry helper honoring 429 Retry-After (seconds) and refreshing tokens on 401. */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  { tries = 5 }: { tries?: number } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await ensureAccessToken();
      return await fn();
    } catch (err: any) {
      const status = err?.statusCode ?? err?.status ?? 0;
      const headers = err?.headers ?? {};
      if (status === 401 && attempt < tries) {
        // likely expired token
        const data = await spotify.refreshAccessToken();
        spotify.setAccessToken(data.body.access_token);
        continue;
      }
      if (status === 429 && attempt < tries) {
        const retryAfterSec = Number(
          headers["retry-after"] ?? headers["Retry-After"] ?? 1,
        );
        await sleep(Math.max(1, retryAfterSec) * 1000);
        continue;
      }
      if (attempt < tries) {
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
  }
}

export type SavedTrackItem = {
  added_at: string; // ISO 8601
  track: SpotifyApi.TrackObjectFull;
};

export async function getSavedTracksPaginated(limit = 50, offset = 0) {
  return callWithRetry(
    () => spotify.getMySavedTracks({ limit, offset }), // limit max 50
  );
}

export async function* iterateSavedTracks() {
  const limit = 50;
  let offset = 0;
  while (true) {
    const res = await getSavedTracksPaginated(limit, offset);
    const items = res.body.items as SavedTrackItem[];
    if (!items.length) break;
    for (const it of items) yield it;
    offset += items.length;
    if (!res.body.next) break;
  }
}

export async function getPlaylistItemsPaginated(
  playlistId: string,
  limit = 50,
  offset = 0,
) {
  return callWithRetry(() =>
    spotify.getPlaylistTracks(playlistId, { limit, offset }),
  );
}

export async function* iteratePlaylistTracks(playlistId: string) {
  const limit = 50;
  let offset = 0;
  while (true) {
    const res = await getPlaylistItemsPaginated(playlistId, limit, offset);
    const items = res.body.items ?? [];
    if (!items.length) break;
    for (const it of items) {
      // Item can be track or episode; we care about tracks
      const track = (it as SpotifyApi.PlaylistTrackObject).track;
      if (track && track.type === "track")
        yield track as SpotifyApi.TrackObjectFull;
    }
    offset += items.length;
    if (!res.body.next) break;
  }
}

export async function getSeveralArtists(ids: string[]) {
  return callWithRetry(() => spotify.getArtists(ids));
}

export function toTrackUri(id: string) {
  return `spotify:track:${id}`;
}

export async function addTracksToPlaylist(
  playlistId: string,
  trackIds: string[],
) {
  // Add in batches of 100
  for (let i = 0; i < trackIds.length; i += 100) {
    const slice = trackIds.slice(i, i + 100).map(toTrackUri);
    await callWithRetry(() => spotify.addTracksToPlaylist(playlistId, slice));
  }
}

// add near other exports
export async function getPlaylistTrackIdsSet(
  playlistId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const track of iteratePlaylistTracks(playlistId)) {
    if (track.id) ids.add(track.id);
  }
  return ids;
}

export async function addTracksToPlaylistIfMissing(
  playlistId: string,
  trackIds: string[],
) {
  const existing = await getPlaylistTrackIdsSet(playlistId);
  const toAdd = trackIds.filter((id) => !existing.has(id));
  if (toAdd.length === 0) return { added: 0, skipped: trackIds.length };

  for (let i = 0; i < toAdd.length; i += 100) {
    const slice = toAdd.slice(i, i + 100).map(toTrackUri);
    await callWithRetry(() => spotify.addTracksToPlaylist(playlistId, slice));
  }
  return { added: toAdd.length, skipped: trackIds.length - toAdd.length };
}

export async function getPlaylistSnapshot(playlistId: string) {
  const res = await callWithRetry(() =>
    spotify.getPlaylist(playlistId, { fields: "snapshot_id,tracks.total" }),
  );
  return {
    snapshotId: (res.body as any).snapshot_id as string,
    tracksTotal: (res.body as any).tracks?.total as number,
  };
}
