import "dotenv/config";
import {
  iterateSavedTracks,
  getSeveralArtists,
  addTracksToPlaylistIfMissing,
} from "./spotify.js";
import { readState, writeState } from "./state.js";
import {
  buildPlaylistGenreProfile,
  pickBestPlaylist,
  scoreTrackAgainstProfile,
} from "./genreRouter.js";

// Rebluild genre profiles every 24 hours by default
const REBUILD_GENRE_PROFILE_INTERVAL = process.env
  .REBUILD_GENRE_PROFILE_INTERVAL
  ? parseInt(process.env.REBUILD_GENRE_PROFILE_INTERVAL)
  : 24;

function extractPlaylistId(raw: string): string | null {
  const s = raw.trim();

  // Case 1: spotify:playlist:<id>
  const colon = s.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (colon) return colon[1];

  // Case 2: https://open.spotify.com/playlist/<id>?...
  const url = s.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (url) return url[1];

  // Case 3: bare id (possibly with ?something)
  const bare = s.split("?")[0];
  if (/^[a-zA-Z0-9]+$/.test(bare)) return bare;

  return null;
}

function getTargetPlaylistIds(): string[] {
  const out: string[] = [];
  const push = (v?: string) => {
    if (!v) return;
    const id = extractPlaylistId(v);
    if (id) out.push(id);
    else console.warn("Skipping unrecognized playlist value:", v);
  };

  if (process.env.TARGET_PLAYLIST_IDS) {
    for (const part of process.env.TARGET_PLAYLIST_IDS.split(",")) push(part);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("TARGET_PLAYLIST_ID_")) push(v);
  }
  return Array.from(new Set(out));
}

/**
 * Check if a playlist's genre profile should be rebuilt based on the last rebuild time
 * and the configured rebuild interval
 */
function shouldRebuildProfile(lastRebuildTime: string | undefined): boolean {
  if (!lastRebuildTime) return true;

  const now = new Date();
  const lastRebuild = new Date(lastRebuildTime);
  const hoursSinceLastRebuild =
    (now.getTime() - lastRebuild.getTime()) / (1000 * 60 * 60);

  return hoursSinceLastRebuild >= REBUILD_GENRE_PROFILE_INTERVAL;
}

async function main() {
  const state = await readState();
  if (!state.lastProfileRebuildTime) {
    state.lastProfileRebuildTime = {};
  }

  // First run: set watermark to now and exit without modifying playlists
  if (!state.lastProcessedAddedAt) {
    const nowIso = new Date().toISOString();
    await writeState({
      lastProcessedAddedAt: nowIso,
      lastProfileRebuildTime: state.lastProfileRebuildTime,
    });
    console.log(
      `Initialized watermark to ${nowIso}. No existing likes will be processed.`,
    );
    return;
  }

  const targetPlaylists = getTargetPlaylistIds();
  if (targetPlaylists.length === 0) {
    throw new Error(
      "Configure at least one TARGET_PLAYLIST_ID_* or TARGET_PLAYLIST_IDS in .env",
    );
  }

  console.log("Target playlists:", targetPlaylists.join(", "));

  // Build genre profiles for each target playlist only if needed
  const profiles: Record<string, Map<string, number>> = {};
  const updatedLastProfileRebuildTime = { ...state.lastProfileRebuildTime };

  for (const pid of targetPlaylists) {
    const lastRebuildTime = state.lastProfileRebuildTime?.[pid];
    const needsRebuild = shouldRebuildProfile(lastRebuildTime);

    if (needsRebuild) {
      console.log(
        `Building genre profile for ${pid} (last rebuilt: ${lastRebuildTime || "never"}) ...`,
      );
      profiles[pid] = await buildPlaylistGenreProfile(pid);
      console.log("Profile genres count:", profiles[pid].size);

      updatedLastProfileRebuildTime[pid] = new Date().toISOString();
    } else {
      console.log(
        `Using cached genre profile for ${pid} (last rebuilt: ${lastRebuildTime}, interval: ${REBUILD_GENRE_PROFILE_INTERVAL}h)`,
      );
      profiles[pid] = await buildPlaylistGenreProfile(pid);
    }
  }

  const newTrackIdsByPlaylist: Record<string, string[]> = {};
  let newestAddedAt: string | undefined = state.lastProcessedAddedAt;

  for await (const item of iterateSavedTracks()) {
    const addedAt = item.added_at;

    if (!newestAddedAt || addedAt > newestAddedAt) newestAddedAt = addedAt;

    if (state.lastProcessedAddedAt && addedAt <= state.lastProcessedAddedAt)
      break;

    const track = item.track;
    const artistIds = track.artists.map((a) => a.id).filter(Boolean);
    const genres = new Set<string>();
    for (let i = 0; i < artistIds.length; i += 50) {
      const res = await getSeveralArtists(artistIds.slice(i, i + 50));
      for (const artist of res.body.artists ?? []) {
        for (const g of artist.genres ?? []) genres.add(g);
      }
    }
    const trackGenres = [...genres];

    // Debugging stuff
    const scores = Object.entries(profiles)
      .map(([pid, prof]) => {
        return [pid, scoreTrackAgainstProfile(trackGenres, prof)] as const;
      })
      .sort((a, b) => b[1] - a[1]);

    const [bestPid, bestScore] = scores[0] ?? [targetPlaylists[0], 0];

    // Debugging: Log top 5 genres and per-playlist scores
    const topGenres = trackGenres.slice(0, 5).join(", ") || "n/a";
    console.log(
      `Scores => ${scores.map(([pid, s]) => `${pid}:${s}`).join(" | ")}`,
    );
    console.log(`Top genres: ${topGenres}`);

    const best =
      pickBestPlaylist(trackGenres, profiles) ?? bestPid ?? targetPlaylists[0];
    (newTrackIdsByPlaylist[best] ??= []).push(track.id);
    console.log(
      `Route "${track.name}" -> ${best} (genres: ${trackGenres.join(", ") || "n/a"})`,
    );
  }

  for (const [pid, ids] of Object.entries(newTrackIdsByPlaylist)) {
    if (!ids.length) continue;
    console.log(`Considering ${ids.length} tracks for ${pid} …`);
    const res = await addTracksToPlaylistIfMissing(pid, ids);
    console.log(`Added ${res.added}, skipped as duplicates ${res.skipped}.`);
  }

  const updatedState = { ...state };

  if (newestAddedAt && newestAddedAt > state.lastProcessedAddedAt) {
    updatedState.lastProcessedAddedAt = newestAddedAt;
    console.log("Updated lastProcessedAddedAt ->", newestAddedAt);
  }

  updatedState.lastProfileRebuildTime = updatedLastProfileRebuildTime;

  await writeState(updatedState);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
