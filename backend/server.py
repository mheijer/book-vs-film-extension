import os
import re
import json
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))

app = Flask(__name__)
CORS(app, origins="*", allow_headers=["Content-Type"], methods=["POST", "OPTIONS"])

client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
OPENSUBTITLES_API_KEY = os.environ.get("OPENSUBTITLES_API_KEY")
OPENSUBTITLES_BASE = "https://api.opensubtitles.com/api/v1"


# --- OpenSubtitles helpers ---

def fetch_subtitles_window(title, year, timestamp_seconds, window_seconds=300, season=None, episode=None):
    """
    Fetch a subtitle file from OpenSubtitles and return lines within
    window_seconds before and after timestamp_seconds.
    Returns a plain string of dialogue, or None if unavailable.
    """
    if not OPENSUBTITLES_API_KEY:
        return None

    headers = {
        "Api-Key": OPENSUBTITLES_API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "BookVsFilm/1.0"
    }

    is_series = season is not None and episode is not None

    # Search for subtitles
    params = {
        "query": title,
        "languages": "en",
        "type": "episode" if is_series else "movie",
    }
    if year:
        params["year"] = year
    if is_series:
        params["season_number"] = season
        params["episode_number"] = episode

    try:
        search_resp = requests.get(
            f"{OPENSUBTITLES_BASE}/subtitles",
            headers=headers,
            params=params,
            timeout=10
        )
        search_resp.raise_for_status()
        results = search_resp.json().get("data", [])

        if not results:
            print("[OpenSubtitles] No results found", flush=True)
            return None

        # Pick the first English result with the most downloads (most reliable)
        file_id = None
        for result in results[:5]:
            files = result.get("attributes", {}).get("files", [])
            if files:
                file_id = files[0].get("file_id")
                break

        if not file_id:
            return None

        # Get download URL
        dl_resp = requests.post(
            f"{OPENSUBTITLES_BASE}/download",
            headers=headers,
            json={"file_id": file_id, "sub_format": "srt"},
            timeout=10
        )
        dl_resp.raise_for_status()
        download_url = dl_resp.json().get("link")

        if not download_url:
            return None

        # Download the .srt file
        srt_resp = requests.get(download_url, timeout=15)
        srt_resp.raise_for_status()
        srt_content = srt_resp.text

        # Parse and extract window around timestamp
        return parse_srt_window(srt_content, timestamp_seconds, window_seconds)

    except Exception as e:
        print(f"[OpenSubtitles] Error: {e}", flush=True)
        return None


def parse_srt_window(srt_content, timestamp_seconds, window_seconds):
    """
    Parse an SRT file and return dialogue lines within window_seconds
    of timestamp_seconds as a plain string.
    """
    start = timestamp_seconds - window_seconds
    end = timestamp_seconds + window_seconds

    lines = []
    blocks = re.split(r'\n\s*\n', srt_content.strip())

    for block in blocks:
        block_lines = block.strip().split('\n')
        if len(block_lines) < 2:
            continue

        # Find the timecode line (format: 00:01:23,456 --> 00:01:25,789)
        timecode_line = None
        text_lines = []
        for i, line in enumerate(block_lines):
            if '-->' in line:
                timecode_line = line
                text_lines = block_lines[i+1:]
                break

        if not timecode_line or not text_lines:
            continue

        # Parse start time
        match = re.match(r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})', timecode_line)
        if not match:
            continue

        h, m, s, ms = int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(4))
        subtitle_time = h * 3600 + m * 60 + s + ms / 1000

        if start <= subtitle_time <= end:
            text = ' '.join(text_lines).strip()
            # Strip HTML tags like <i>
            text = re.sub(r'<[^>]+>', '', text)
            if text:
                lines.append(text)

    return ' '.join(lines) if lines else None


# --- Prompt builders ---

def build_detection_prompt(data, full_subtitle_context):
    season_episode_str = ""
    if data.get("season") and data.get("episode"):
        ep_title = data.get("episode_title", "")
        season_episode_str = f", Season {data['season']} Episode {data['episode']}"
        if ep_title:
            season_episode_str += f' "{ep_title}"'

    timestamp_pct = (data["timestamp_seconds"] / data["runtime_seconds"]) * 100

    if full_subtitle_context:
        subtitle_section = f'Dialogue from ±3 minutes around this moment:\n"""\n{full_subtitle_context}\n"""'
    elif data.get('subtitle_context', '').strip():
        subtitle_section = f'Recent dialogue (last few minutes): "{data["subtitle_context"]}"'
    else:
        subtitle_section = "No subtitle data available."

    return f"""You are identifying whether a film or show is based on a published book.

Title: "{data['title']}" ({data['year']}){season_episode_str}
Timestamp: {data['timestamp_seconds']}s into the content ({timestamp_pct:.1f}% through runtime)
{subtitle_section}

Your task:
1. Determine if this film or show is a direct adaptation of a published book or novel.
   - Cast a wide net: include romance novels, YA fiction, literary fiction, genre fiction.
   - If the title exactly matches a known book, assume it is an adaptation unless you have strong evidence otherwise.

2. Use the dialogue and timestamp to identify the specific scene. Write a single punchy sentence
   naming what is happening in the film right now — focus on what makes this moment notable or different
   from the book, not a general plot summary.

3. Rate your confidence in your knowledge of this specific book (not just the title):
   - 5 = You know the book in detail and can cite specific scenes and dialogue
   - 4 = You know the book well but may be fuzzy on details
   - 3 = You know the general plot and characters but not scene-level detail
   - 2 = You only know the book exists and its premise
   - 1 = You are guessing based on the title alone

Return ONLY a valid JSON object:
{{
  "book_detected": true or false,
  "book_title": "exact title or null",
  "author": "full name or null",
  "book_year": publication year as integer or null,
  "scene_description": "one punchy sentence about what is happening in the film right now — or null",
  "book_confidence": integer 1-5 or null
}}"""


def build_comparison_prompt(title, year, book_title, author, book_year, scene_description, full_subtitle_context, live_subtitle_context, book_confidence):
    book_ref = f'"{book_title}" ({book_year}) by {author}' if book_year else f'"{book_title}" by {author}'

    if full_subtitle_context:
        subtitle_section = f'Dialogue from ±3 minutes around this moment in the film:\n"""\n{full_subtitle_context}\n"""'
    elif live_subtitle_context:
        subtitle_section = f'Dialogue captured from the film: "{live_subtitle_context}"'
    else:
        subtitle_section = ""

    confidence_instruction = ""
    if book_confidence and book_confidence <= 2:
        confidence_instruction = "\nIMPORTANT: Your knowledge of this book is limited. For any dimension you can't speak to specifically, write 'Unknown — insufficient data' rather than guessing."
    elif book_confidence and book_confidence >= 4:
        confidence_instruction = "\nYou know this book well. Be specific — cite actual character names, dialogue, chapter details, and concrete differences. No hedging."

    return f"""You are comparing the film "{title}" ({year}) to its source novel {book_ref}.

What is happening in the film right now:
{scene_description}

{subtitle_section}
{confidence_instruction}

Step 1 — Recall the book scene:
Before comparing, identify the specific moment in the novel that corresponds to this scene. Name the chapter or section if you know it. Recall who is present, what is said, and what the emotional stakes are. Hold this in mind for the comparison below.

Step 2 — Compare across 5 dimensions:

RULES:
- Every sentence must be specific to "{title}" and {book_ref}. No generic statements about adaptations.
- Use the dialogue above as ground truth for what is in the film. Quote specific lines where relevant.
- If you don't know a specific fact, write "Unknown — insufficient data." Never generalize.

Dimensions:
  - dialogue: Quote or closely paraphrase specific lines from the film's dialogue above, then state what the book says at this exact moment. Note word-for-word changes or invented lines.
  - characters: Name every character present in this scene in both versions. Call out any additions, omissions, or role changes.
  - setting: Name the exact location in the film and in the book. Note if it was moved or reimagined.
  - timing: Name the chapter or story beat in the book this corresponds to. State whether the film moved it earlier, later, or kept it in place.
  - vibe: Describe the specific emotional register of this moment — what the character(s) feel and how each version conveys it. Point to a concrete technique (e.g. internal monologue vs. visual shorthand).

For each dimension:
  - "rating": exactly one of "Faithful", "Modified", or "Very Different"
  - "detail": one short, specific sentence — no more than 20 words, grounded in this book and film only

Also:
  - "book_passage": 2-3 sentences describing what happens at this moment in the novel — focus on concrete details (who, what, how) that differ from the film.
  - "key_difference": The single most surprising or dramatic change between film and book — one punchy sentence. Lead with the most unexpected change.
  - "chapter": The specific chapter(s) in the book this scene corresponds to. Use the format "Chapter 12", "Chapter 12 — [Title]" if the chapter has a title, "Chapters 8–10" if it spans multiple, or null if the scene has no direct book equivalent (i.e. invented for the film).

Return ONLY a valid JSON object:
{{
  "book_passage": "2-3 sentences with concrete details from the novel at this moment",
  "key_difference": "the single most interesting change — one punchy sentence",
  "chapter": "Chapter 12" or "Chapters 8–10" or null,
  "dialogue":   {{ "rating": "Faithful|Modified|Very Different", "detail": "one specific sentence, max 20 words" }},
  "characters": {{ "rating": "Faithful|Modified|Very Different", "detail": "one specific sentence, max 20 words" }},
  "setting":    {{ "rating": "Faithful|Modified|Very Different", "detail": "one specific sentence, max 20 words" }},
  "timing":     {{ "rating": "Faithful|Modified|Very Different", "detail": "one specific sentence, max 20 words" }},
  "vibe":       {{ "rating": "Faithful|Modified|Very Different", "detail": "one specific sentence, max 20 words" }}
}}"""


def parse_json_response(text):
    """Robustly parse a JSON response from Claude, stripping markdown fences if present."""
    text = text.strip()
    if text.startswith("```"):
        parts = text.split("```")
        # parts[1] is the content between first pair of fences
        text = parts[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Invalid request"}), 400

        live_subtitles = data.get("subtitle_context", "").strip()
        print(f"[DEBUG] Title: {data.get('title')} | Live subtitles: '{live_subtitles[:100] if live_subtitles else 'NONE'}'", flush=True)

        # Fetch full subtitle window from OpenSubtitles
        full_subtitles = fetch_subtitles_window(
            data.get("title"),
            data.get("year"),
            data.get("timestamp_seconds", 0),
            window_seconds=180,
            season=data.get("season"),
            episode=data.get("episode")
        )
        print(f"[DEBUG] OpenSubtitles window: '{full_subtitles[:200] if full_subtitles else 'NONE'}'", flush=True)

        # Check for manual override
        override_book_title = data.get("override_book_title")
        override_author = data.get("override_author")

        if override_book_title:
            detection = {
                "book_detected": True,
                "book_title": override_book_title,
                "author": override_author or "Unknown",
                "book_confidence": 3,
                "scene_description": None
            }
            scene_prompt = f"""Given these subtitles from "{data['title']}" at {data.get('timestamp_seconds', 0)}s into the content:
"{full_subtitles or live_subtitles or 'No subtitle data'}"

Write one sentence describing what is happening in this scene right now."""
            scene_resp = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=150,
                messages=[{"role": "user", "content": scene_prompt}]
            )
            detection["scene_description"] = scene_resp.content[0].text.strip()
            book_confidence = 3
        else:
            # Step 1: detect book and identify scene
            detection_prompt = build_detection_prompt(data, full_subtitles)
            detection_response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=600,
                messages=[{"role": "user", "content": detection_prompt}]
            )
            try:
                detection = parse_json_response(detection_response.content[0].text)
            except (json.JSONDecodeError, IndexError) as e:
                print(f"[ERROR] Detection JSON parse failed: {e}", flush=True)
                return jsonify({"error": "Failed to parse book detection response"}), 500

            if not detection.get("book_detected"):
                return jsonify({
                    "book_detected": False,
                    "book_title": None,
                    "author": None,
                    "scene_description": None,
                    "book_passage": None,
                    "key_difference": None,
                    "book_confidence": None,
                    "comparison": None
                })

            book_confidence = detection.get("book_confidence", 3)

        # Step 2: compare scene to book
        comparison_prompt = build_comparison_prompt(
            data["title"],
            data["year"],
            detection["book_title"],
            detection["author"],
            detection.get("book_year"),
            detection["scene_description"],
            full_subtitles,
            live_subtitles,
            book_confidence
        )
        comparison_response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1800,
            messages=[{"role": "user", "content": comparison_prompt}]
        )
        try:
            comparison = parse_json_response(comparison_response.content[0].text)
        except (json.JSONDecodeError, IndexError) as e:
            print(f"[ERROR] Comparison JSON parse failed: {e}", flush=True)
            return jsonify({"error": "Failed to parse comparison response"}), 500

        return jsonify({
            "book_detected": True,
            "book_title": detection["book_title"],
            "author": detection["author"],
            "scene_description": detection["scene_description"],
            "book_passage": comparison.get("book_passage"),
            "key_difference": comparison.get("key_difference"),
            "chapter": comparison.get("chapter"),
            "book_confidence": book_confidence,
            "comparison": {
                "dialogue": comparison.get("dialogue"),
                "characters": comparison.get("characters"),
                "setting": comparison.get("setting"),
                "timing": comparison.get("timing"),
                "vibe": comparison.get("vibe")
            }
        })

    except Exception as e:
        print(f"[ERROR] Unhandled exception: {e}", flush=True)
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(debug=False, host="0.0.0.0", port=port)
