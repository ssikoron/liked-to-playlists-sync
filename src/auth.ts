import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";
import SpotifyWebApi from "spotify-web-api-node";

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI = "http://localhost:3000/callback",
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  throw new Error("Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env");
}

const scopes = [
  "user-library-read",
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
];

const spotify = new SpotifyWebApi({
  clientId: SPOTIFY_CLIENT_ID,
  clientSecret: SPOTIFY_CLIENT_SECRET,
  redirectUri: SPOTIFY_REDIRECT_URI,
});

const state = crypto.randomBytes(16).toString("hex");
const authUrl = spotify.createAuthorizeURL(scopes, state);

console.log("\nOpen this URL in your browser to authorize:\n");
console.log(authUrl, "\n");

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) return;
    const url = new URL(req.url, SPOTIFY_REDIRECT_URI);
    if (url.pathname !== "/callback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) throw new Error(`Spotify error: ${error}`);
    if (!code) throw new Error("Missing code param");
    if (returnedState !== state) throw new Error("State mismatch");

    const data = await spotify.authorizationCodeGrant(code);

    const accessToken = data.body.access_token;
    const refreshToken = data.body.refresh_token;
    const expiresIn = data.body.expires_in;

    console.log("\n=== AUTH SUCCESS ===");
    console.log("Access token (expires in seconds):", expiresIn);
    console.log("Refresh token (save this in .env):");
    console.log(refreshToken);
    console.log("====================\n");

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("Auth OK. You can close this tab and return to the terminal.");

    server.close();
  } catch (e: any) {
    console.error("Auth error:", e?.message ?? e);
    res.statusCode = 500;
    res.end("Auth failed. See terminal for details.");
    server.close();
  }
});

server.listen(3000, () => {
  console.log("Listening on http://localhost:3000/callback");
});
