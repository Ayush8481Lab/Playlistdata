// pages/api/playlists.js

// Allow longer execution time on Vercel (Hobby max is 10s, Pro is 300s)
export const config = {
    maxDuration: 60, 
};

// --- Helper: Decode Entities ---
const decodeEntities = (str) => {
    return (str || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'");
};

// --- Helper: Process items in chunks to avoid rate limits/timeouts ---
async function processInChunks(items, fn, chunkSize = 15) {
    const results = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

// --- Helper: Fetch Track Info (Genre, Year, Composer, Release Date) ---
async function getTrackDetails(trackId) {
    try {
        const res = await fetch(`https://apiv2.gaana.com/track/info?track_id=${trackId}`);
        if (!res.ok) return {};
        const data = await res.json();
        
        const genre = data.tags && data.tags.length > 0 ? data.tags[0].tag_name : "";
        const release_date = data.release_date || "";
        const year = release_date ? release_date.split("-")[0] : "";
        const composers = data.composers ? data.composers.map(c => c.name).join(", ") : "";

        return { genre, release_date, year, composers };
    } catch (e) {
        return { genre: "", release_date: "", year: "", composers: "" };
    }
}

// --- Helper: Spotify Matching Algorithm (Adapted from Player) ---
async function getSpotifyId(title, artist) {
    const RAPID_KEYS = [
        "d1edce158amshec139440d20658ap1f2545jsnbb7da9add82f",
        "6cf7f03014msh787c51a713c0264p15c20djsna1f9a9f6a378",
        "13d48f6bb8msh459c11b91bdcc44p110f4ejsn099443894115",
        "03fc23317fmsh0535ef9ec8c6f5bp1db59bjsn545991df9343"
    ];
    // Randomize keys to avoid hitting limits
    const key = RAPID_KEYS[Math.floor(Math.random() * RAPID_KEYS.length)];
    const query = `${title} ${artist}`.trim();
    const searchUrl = `https://spotify81.p.rapidapi.com/search?q=${encodeURIComponent(query)}&type=tracks&offset=0&limit=10&numberOfTopResults=5`;

    try {
        const res = await fetch(searchUrl, {
            headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'spotify81.p.rapidapi.com' }
        });
        if (!res.ok) return null;
        
        const matchData = await res.json();
        const clean = (s) => decodeEntities(s || "").toLowerCase().replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").trim();
        
        const tTitle = clean(title);
        const tArtist = clean(artist);
        let bestMatch = null;
        let highestScore = 0;

        if (matchData.tracks) {
            matchData.tracks.forEach((item) => {
                const track = item.data || item;
                if (!track) return;
                const rTitle = clean(track.name);
                const rArtists = (track.artists?.items || track.artists || []).map(a => clean(a.profile?.name || a.name));

                let score = 0;
                let artistMatched = false;
                
                if (tArtist.length > 0) {
                    for (let ra of rArtists) {
                        if (ra === tArtist) { score += 100; artistMatched = true; break; }
                        else if (ra.includes(tArtist) || tArtist.includes(ra)) { score += 80; artistMatched = true; break; }
                    }
                    if (!artistMatched) score = 0;
                } else {
                    score += 50;
                }

                if (score > 0) {
                    if (rTitle === tTitle) score += 100;
                    else if (rTitle.startsWith(tTitle) || tTitle.startsWith(rTitle)) score += 80;
                    else if (rTitle.includes(tTitle)) score += 50;
                }

                if (score > highestScore) { highestScore = score; bestMatch = track; }
            });
        }
        return bestMatch ? bestMatch.id : null;
    } catch (e) {
        return null;
    }
}

// --- Main API Handler ---
export default async function handler(req, res) {
    const { seo, limit } = req.query;

    if (!seo) {
        return res.status(400).json({ error: "Missing 'seo' query parameter" });
    }

    try {
        // 1. Fetch original Playlist from Gaana
        const playlistRes = await fetch(`https://gaanaayush.vercel.app/api/playlists/${seo}`);
        const playlistJson = await playlistRes.json();

        if (!playlistJson.data?.data?.playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        const originalPlaylist = playlistJson.data.data.playlist;
        let originalTracks = originalPlaylist.tracks || [];
        
        // Optional: Cut track length via query ?limit=20 to prevent Vercel Timeout
        if (limit) {
            originalTracks = originalTracks.slice(0, parseInt(limit));
        }

        // 2. Process all tracks concurrently in chunks
        const processedTracks = await processInChunks(originalTracks, async (track) => {
            // First Artist to use for Spotify Search
            const firstArtist = track.artists ? track.artists.split(',')[0].trim() : "";
            
            // Parallel fetch Gaana Track Info & Spotify Match
            const [details, spotifyId] = await Promise.all([
                getTrackDetails(track.track_id),
                getSpotifyId(track.title, firstArtist)
            ]);

            // Construct new clean Track object
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
                genre: details.genre || "",
                year: details.year || "",
                release_date: details.release_date || "",
                composers: details.composers || "",
                spotify_id: spotifyId || ""
            };
        });

        // 3. Construct Final Payload Output
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
                meta: playlistJson.data.meta
            },
            meta: {
                project: "Gaana Extended Playlist API",
                version: "2.0.0",
                author: "Ayush Kumaryadav",
                timestamp: new Date().toISOString()
            }
        };

        // Send Response
        res.setHeader('Content-Type', 'application/json');
        res.status(200).send(JSON.stringify(finalResponse, null, 2));

    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
}
