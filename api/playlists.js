// pages/api/playlists.js

// Allow longer execution time on Vercel (Hobby max is 10s, Pro is 300s)
export const config = {
    maxDuration: 60,
};

// --- VERCEL PROTECTION BYPASS ---
const AUTOMATION_SECRET = "pR3nSUsTI9HQxb2RbdasB5mjKqUoSP8m";
const bypassHeaders = { "x-vercel-protection-bypass": AUTOMATION_SECRET };

// --- Helper: Decode Entities ---
const decodeEntities = (text) => {
    if (!text) return "";
    return text
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&apos;/g, "'");
};

// --- Helper: Process items in chunks to avoid server overloads ---
async function processInChunks(items, fn, chunkSize = 15) {
    const results = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

// --- Helper: Fetch Pro Auth Token once per request ---
async function getAuthData() {
    try {
        const res = await fetch('https://serverayush.vercel.app/api/auth', {
            headers: { ...bypassHeaders }
        });
        if (!res.ok) return null;
        const data = await res.json();
        // Fallback for jina wrapper just in case the API returns wrapped data
        if (data && data.data && data.data.content) {
            const match = data.data.content.match(/```(?:json)?\n([\s\S]*?)\n```/);
            return match ? JSON.parse(match[1]) : JSON.parse(data.data.content);
        }
        return data;
    } catch (e) {
        console.error("Failed to fetch Auth Token:", e);
        return null;
    }
}

// --- Helper: Fetch Track Info (Genre, Year, Composer, Release Date) ---
async function getTrackDetails(trackId) {
    try {
        // You can use apiv2.gaana.com or your superserch endpoint if apiv2 blocks Vercel IPs
        const res = await fetch(`https://gaanaayush.vercel.app/api/superserch/track/info?track_id=${trackId}`, {
            headers: { ...bypassHeaders }
        });
        if (!res.ok) return {};
        const json = await res.json();
        const data = json.data || json;

        const genre = data.tags && data.tags.length > 0 ? data.tags[0].tag_name : "";
        const release_date = data.release_date || "";
        const year = release_date ? release_date.split("-")[0] : "";
        const composers = data.composers ? data.composers.map((c) => c.name).join(", ") : "";

        return { genre, release_date, year, composers };
    } catch (e) {
        return { genre: "", release_date: "", year: "", composers: "" };
    }
}

// --- Helper: AK47 Matching Algorithm (From your Player code) ---
const performAK47Matching = (results, targetTrack, targetArtist) => {
    if (!results || results.length === 0) return null;
    const clean = (s) => decodeEntities(s || "").toLowerCase().replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").trim();
    const tTitle = clean(targetTrack);
    const tArtist = clean(targetArtist);
    let bestMatch = null;
    let highestScore = 0;

    results.forEach((track) => {
        if (!track) return;
        const rTitle = clean(track.song_name);
        const rArtists = clean(track.artist);
        let score = 0;
        let artistMatched = false;

        if (tArtist.length > 0) {
            if (rArtists === tArtist) { score += 100; artistMatched = true; }
            else if (rArtists.includes(tArtist) || tArtist.includes(rArtists)) { score += 80; artistMatched = true; }
            else {
                const tSplit = tArtist.split(" ");
                for (let t of tSplit) { 
                    if (t.length > 2 && rArtists.includes(t)) { score += 50; artistMatched = true; break; } 
                }
            }
            if (!artistMatched) score = 0;
        } else score += 50;

        if (score > 0) {
            if (rTitle === tTitle) score += 100;
            else if (rTitle.startsWith(tTitle) || tTitle.startsWith(rTitle)) score += 80;
            else if (rTitle.includes(tTitle) || tTitle.includes(rTitle)) score += 50;
        }
        
        if (score > highestScore) { 
            highestScore = score; 
            bestMatch = track; 
        }
    });
    
    if (highestScore > 0) return bestMatch;
    return results[0]; // Fallback to first result if no strong match
};

// --- Helper: Search Spotify ID using Custom AK47 API ---
async function getSpotifyId(title, artist, auth) {
    if (!auth || !auth.accessToken) return null;

    const query = `${title} ${artist}`.trim();
    const searchUrl = `https://ak47ayush.vercel.app/search?q=${encodeURIComponent(query)}&CID=${auth.clientId}&token=${auth.accessToken}&limit=15&offset=0`;

    try {
        const res = await fetch(searchUrl, {
            headers: { ...bypassHeaders }
        });
        if (!res.ok) return null;

        const authJson = await res.json();
        
        if (authJson && authJson.results && Array.isArray(authJson.results) && authJson.results.length > 0) {
            const match = performAK47Matching(authJson.results, title, artist);
            if (match) {
                // Extract ID safely based on your AK47 API response structure
                const sId = match.id || 
                            (match.spotify_url && match.spotify_url.split('/track/')[1]?.split('?')[0]) || 
                            (match.external_urls?.spotify?.split('/track/')[1]?.split('?')[0]);
                return sId || null;
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// --- Main API Handler ---
export default async function handler(req, res) {
    // --- CORS Configuration Setup ---
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); // Adjust '*' to your specific domain if needed for strict security
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Handle Preflight (OPTIONS) Request for CORS
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { seo, limit } = req.query;

    if (!seo) {
        return res.status(400).json({ error: "Missing 'seo' query parameter. Example: ?seo=gaana-dj-international-weekly-hot-20" });
    }

    try {
        // 1. Fetch Playlist from Gaana using Bypass Header
        const playlistRes = await fetch(`https://gaanaayush.vercel.app/api/playlists/${seo}`, {
            headers: { ...bypassHeaders }
        });
        const playlistJson = await playlistRes.json();

        if (!playlistJson.data?.data?.playlist) {
            return res.status(404).json({ error: "Playlist not found or blocked by protection." });
        }

        const originalPlaylist = playlistJson.data.data.playlist;
        let originalTracks = originalPlaylist.tracks || [];

        // Optional: Slice tracks to avoid Vercel timeout limits
        if (limit) {
            originalTracks = originalTracks.slice(0, parseInt(limit));
        }

        // 2. Pre-fetch Auth Token once so we don't spam the Auth API for every single track
        const authData = await getAuthData();

        // 3. Process Tracks Concurrently in chunks (to respect API limits)
        const processedTracks = await processInChunks(originalTracks, async (track) => {
            // Pick primary artist for higher accuracy in AK47 matching
            const firstArtist = track.artists ? track.artists.split(',').slice(0, 2).join(' ') : "";
            const cleanTitle = decodeEntities(track.title);

            // Parallel execution: Get Extended Info + Spotify ID Match
            const [details, spotifyId] = await Promise.all([
                getTrackDetails(track.track_id),
                getSpotifyId(cleanTitle, firstArtist, authData)
            ]);

            return {
                seokey: track.seokey,
                track_id: track.track_id,
                title: track.title,
                duration: track.duration,
                album_seokey: track.album_seokey,
                album: track.album,
                album_id: track.album_id,
                artists: track.artists,
                artist_seokeys: track.artist_seokeys,
                artist_ids: track.artist_ids,
                artworkUrl: track.artworkUrl,
                genre: details.genre,
                year: details.year,
                release_date: details.release_date,
                composers: details.composers,
                spotify_id: spotifyId || ""
            };
        });

        // 4. Construct Final Response Payload
        const finalResponse = {
            success: true,
            data: {
                success: true,
                data: {
                    playlist: {
                        title: originalPlaylist.title,
                        playlist_id: originalPlaylist.playlist_id,
                        seokey: originalPlaylist.seokey,
                        artworkUrl: originalPlaylist.artworkUrl,
                        description: originalPlaylist.description || "",
                        author: originalPlaylist.author,
                        trackcount: processedTracks.length,
                        favorite_count: originalPlaylist.favorite_count,
                        language: originalPlaylist.language,
                        created_on: originalPlaylist.created_on,
                        modified_on: originalPlaylist.modified_on,
                        playlist_url: originalPlaylist.playlist_url,
                        tracks: processedTracks
                    }
                },
                meta: playlistJson.data.meta || {}
            },
            meta: {
                project: "Gaana Pro Playlist API",
                version: "3.0.0",
                author: "Ayush Kumaryadav",
                timestamp: new Date().toISOString()
            }
        };

        // Send Success
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(finalResponse, null, 2));

    } catch (error) {
        console.error("API Server Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
}
