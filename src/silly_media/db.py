"""SQLite database for actors and metadata storage."""

import logging
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import aiosqlite

from .config import settings

logger = logging.getLogger(__name__)

# Database path
DB_PATH = Path(settings.db_path)
ACTORS_PATH = Path(settings.actors_storage_path)


@dataclass
class Actor:
    """Actor data model."""

    id: str
    name: str
    language: str
    description: str | None
    created_at: datetime
    updated_at: datetime


@dataclass
class ActorAudioFile:
    """Actor audio file data model."""

    id: str
    actor_id: str
    filename: str
    original_name: str | None
    duration_seconds: float | None
    created_at: datetime


@dataclass
class TTSHistoryEntry:
    """TTS generation history entry."""

    id: str
    actor_name: str
    text: str
    language: str
    filename: str
    duration_seconds: float | None
    created_at: datetime


@dataclass
class MayaActor:
    """Maya TTS actor - voice description preset."""

    id: str
    name: str
    voice_description: str
    created_at: datetime
    updated_at: datetime


@dataclass
class VideoJob:
    """Video generation job record."""

    id: str
    model: str
    prompt: str
    resolution: str
    aspect_ratio: str
    num_frames: int
    video_path: str | None
    duration_seconds: float
    created_at: datetime
    completed_at: datetime | None = None


async def init_db() -> None:
    """Initialize the database and create tables if they don't exist."""
    # Ensure directories exist
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    ACTORS_PATH.mkdir(parents=True, exist_ok=True)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS actors (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                language TEXT DEFAULT 'en',
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS actor_audio_files (
                id TEXT PRIMARY KEY,
                actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                original_name TEXT,
                duration_seconds REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Create index for faster lookups
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_actor_audio_files_actor_id
            ON actor_audio_files(actor_id)
        """)

        # TTS generation history
        await db.execute("""
            CREATE TABLE IF NOT EXISTS tts_history (
                id TEXT PRIMARY KEY,
                actor_name TEXT NOT NULL,
                text TEXT NOT NULL,
                language TEXT DEFAULT 'en',
                filename TEXT NOT NULL,
                duration_seconds REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Maya TTS actors (voice description presets)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS maya_actors (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                voice_description TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Video generation jobs
        await db.execute("""
            CREATE TABLE IF NOT EXISTS video_jobs (
                id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                prompt TEXT NOT NULL,
                resolution TEXT NOT NULL,
                aspect_ratio TEXT NOT NULL,
                num_frames INTEGER NOT NULL,
                video_path TEXT,
                duration_seconds REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP
            )
        """)

        await db.commit()

    # Create history directory
    history_dir = ACTORS_PATH.parent / "tts_history"
    history_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Database initialized at {DB_PATH}")


async def create_actor(
    name: str,
    language: str = "en",
    description: str | None = None,
) -> Actor:
    """Create a new actor."""
    actor_id = str(uuid.uuid4())[:8]
    now = datetime.utcnow()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO actors (id, name, language, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (actor_id, name, language, description, now, now),
        )
        await db.commit()

    # Create actor directory for audio files
    actor_dir = ACTORS_PATH / actor_id
    actor_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Created actor: {name} ({actor_id})")

    return Actor(
        id=actor_id,
        name=name,
        language=language,
        description=description,
        created_at=now,
        updated_at=now,
    )


async def add_audio_to_actor(
    actor_id: str,
    audio_bytes: bytes,
    original_filename: str,
    duration_seconds: float | None = None,
) -> ActorAudioFile:
    """Add an audio file to an actor."""
    file_id = str(uuid.uuid4())[:8]
    now = datetime.utcnow()

    # Determine filename
    actor_dir = ACTORS_PATH / actor_id
    actor_dir.mkdir(parents=True, exist_ok=True)

    # Count existing files to determine index
    existing_files = list(actor_dir.glob("reference_*.wav"))
    index = len(existing_files)
    filename = f"reference_{index:02d}.wav"

    # Save audio file
    file_path = actor_dir / filename
    file_path.write_bytes(audio_bytes)

    # Insert into database
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO actor_audio_files
                (id, actor_id, filename, original_name, duration_seconds, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (file_id, actor_id, filename, original_filename, duration_seconds, now),
        )
        await db.commit()

    logger.info(f"Added audio file to actor {actor_id}: {filename}")

    return ActorAudioFile(
        id=file_id,
        actor_id=actor_id,
        filename=filename,
        original_name=original_filename,
        duration_seconds=duration_seconds,
        created_at=now,
    )


async def get_actor(actor_id: str) -> Actor | None:
    """Get an actor by ID."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM actors WHERE id = ?", (actor_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return Actor(
                id=row["id"],
                name=row["name"],
                language=row["language"],
                description=row["description"],
                created_at=datetime.fromisoformat(row["created_at"]),
                updated_at=datetime.fromisoformat(row["updated_at"]),
            )


async def get_actor_by_name(name: str) -> Actor | None:
    """Get an actor by name (case-insensitive)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM actors WHERE LOWER(name) = LOWER(?)", (name,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return Actor(
                id=row["id"],
                name=row["name"],
                language=row["language"],
                description=row["description"],
                created_at=datetime.fromisoformat(row["created_at"]),
                updated_at=datetime.fromisoformat(row["updated_at"]),
            )


async def get_actor_audio_files(actor_id: str) -> list[ActorAudioFile]:
    """Get all audio files for an actor."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM actor_audio_files WHERE actor_id = ? ORDER BY created_at",
            (actor_id,),
        ) as cursor:
            rows = await cursor.fetchall()
            return [
                ActorAudioFile(
                    id=row["id"],
                    actor_id=row["actor_id"],
                    filename=row["filename"],
                    original_name=row["original_name"],
                    duration_seconds=row["duration_seconds"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                )
                for row in rows
            ]


async def get_actor_audio_paths(actor_id: str) -> list[Path]:
    """Get absolute paths to all audio files for an actor."""
    audio_files = await get_actor_audio_files(actor_id)
    actor_dir = ACTORS_PATH / actor_id
    return [actor_dir / f.filename for f in audio_files]


async def list_actors() -> list[Actor]:
    """List all actors."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM actors ORDER BY name") as cursor:
            rows = await cursor.fetchall()
            return [
                Actor(
                    id=row["id"],
                    name=row["name"],
                    language=row["language"],
                    description=row["description"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    updated_at=datetime.fromisoformat(row["updated_at"]),
                )
                for row in rows
            ]


async def get_actor_audio_count(actor_id: str) -> int:
    """Get the number of audio files for an actor."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT COUNT(*) FROM actor_audio_files WHERE actor_id = ?",
            (actor_id,),
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0


async def delete_actor(actor_id: str) -> bool:
    """Delete an actor and all associated files."""
    # Check if actor exists
    actor = await get_actor(actor_id)
    if actor is None:
        return False

    # Delete from database (cascade deletes audio file records)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM actor_audio_files WHERE actor_id = ?", (actor_id,))
        await db.execute("DELETE FROM actors WHERE id = ?", (actor_id,))
        await db.commit()

    # Delete audio files directory
    actor_dir = ACTORS_PATH / actor_id
    if actor_dir.exists():
        shutil.rmtree(actor_dir)

    logger.info(f"Deleted actor: {actor.name} ({actor_id})")
    return True


async def delete_actor_audio_file(actor_id: str, file_id: str) -> bool:
    """Delete a single audio file from an actor."""
    # Get the file info first
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM actor_audio_files WHERE id = ? AND actor_id = ?",
            (file_id, actor_id),
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return False
            filename = row["filename"]

        # Delete from database
        await db.execute(
            "DELETE FROM actor_audio_files WHERE id = ?", (file_id,)
        )
        await db.commit()

    # Delete the physical file
    file_path = ACTORS_PATH / actor_id / filename
    if file_path.exists():
        file_path.unlink()

    logger.info(f"Deleted audio file {file_id} ({filename}) from actor {actor_id}")
    return True


async def update_actor(
    actor_id: str,
    name: str | None = None,
    language: str | None = None,
    description: str | None = None,
) -> Actor | None:
    """Update an actor's metadata."""
    actor = await get_actor(actor_id)
    if actor is None:
        return None

    now = datetime.utcnow()
    new_name = name if name is not None else actor.name
    new_language = language if language is not None else actor.language
    new_description = description if description is not None else actor.description

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE actors
            SET name = ?, language = ?, description = ?, updated_at = ?
            WHERE id = ?
            """,
            (new_name, new_language, new_description, now, actor_id),
        )
        await db.commit()

    return Actor(
        id=actor_id,
        name=new_name,
        language=new_language,
        description=new_description,
        created_at=actor.created_at,
        updated_at=now,
    )


# TTS History functions

TTS_HISTORY_PATH = ACTORS_PATH.parent / "tts_history"


async def add_tts_history(
    actor_name: str,
    text: str,
    language: str,
    audio_bytes: bytes,
    duration_seconds: float | None = None,
) -> TTSHistoryEntry:
    """Add a TTS generation to history."""
    entry_id = str(uuid.uuid4())[:8]
    now = datetime.utcnow()
    filename = f"tts_{entry_id}.wav"

    # Save audio file
    TTS_HISTORY_PATH.mkdir(parents=True, exist_ok=True)
    file_path = TTS_HISTORY_PATH / filename
    file_path.write_bytes(audio_bytes)

    # Insert into database
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO tts_history
                (id, actor_name, text, language, filename, duration_seconds, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (entry_id, actor_name, text, language, filename, duration_seconds, now),
        )
        await db.commit()

    logger.info(f"Added TTS history entry: {entry_id}")

    return TTSHistoryEntry(
        id=entry_id,
        actor_name=actor_name,
        text=text,
        language=language,
        filename=filename,
        duration_seconds=duration_seconds,
        created_at=now,
    )


async def get_tts_history(limit: int = 50) -> list[TTSHistoryEntry]:
    """Get TTS generation history, most recent first."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM tts_history ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ) as cursor:
            rows = await cursor.fetchall()
            return [
                TTSHistoryEntry(
                    id=row["id"],
                    actor_name=row["actor_name"],
                    text=row["text"],
                    language=row["language"],
                    filename=row["filename"],
                    duration_seconds=row["duration_seconds"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                )
                for row in rows
            ]


async def get_tts_history_audio_path(entry_id: str) -> Path | None:
    """Get the audio file path for a history entry."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT filename FROM tts_history WHERE id = ?", (entry_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return TTS_HISTORY_PATH / row["filename"]


async def delete_tts_history_entry(entry_id: str) -> bool:
    """Delete a TTS history entry."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT filename FROM tts_history WHERE id = ?", (entry_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return False
            filename = row["filename"]

        await db.execute("DELETE FROM tts_history WHERE id = ?", (entry_id,))
        await db.commit()

    # Delete the file
    file_path = TTS_HISTORY_PATH / filename
    if file_path.exists():
        file_path.unlink()

    logger.info(f"Deleted TTS history entry: {entry_id}")
    return True


async def clear_tts_history() -> int:
    """Clear all TTS history. Returns number of entries deleted."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM tts_history") as cursor:
            row = await cursor.fetchone()
            count = row[0] if row else 0

        await db.execute("DELETE FROM tts_history")
        await db.commit()

    # Delete all files
    if TTS_HISTORY_PATH.exists():
        for f in TTS_HISTORY_PATH.glob("tts_*.wav"):
            f.unlink()

    logger.info(f"Cleared TTS history: {count} entries")
    return count


# Maya Actor functions


async def create_maya_actor(name: str, voice_description: str) -> MayaActor:
    """Create a new Maya actor (voice description preset)."""
    actor_id = str(uuid.uuid4())[:8]
    now = datetime.utcnow()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO maya_actors (id, name, voice_description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (actor_id, name, voice_description, now, now),
        )
        await db.commit()

    logger.info(f"Created Maya actor: {name} ({actor_id})")

    return MayaActor(
        id=actor_id,
        name=name,
        voice_description=voice_description,
        created_at=now,
        updated_at=now,
    )


async def get_maya_actor(actor_id: str) -> MayaActor | None:
    """Get a Maya actor by ID."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM maya_actors WHERE id = ?", (actor_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return MayaActor(
                id=row["id"],
                name=row["name"],
                voice_description=row["voice_description"],
                created_at=datetime.fromisoformat(row["created_at"]),
                updated_at=datetime.fromisoformat(row["updated_at"]),
            )


async def get_maya_actor_by_name(name: str) -> MayaActor | None:
    """Get a Maya actor by name (case-insensitive)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM maya_actors WHERE LOWER(name) = LOWER(?)", (name,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return MayaActor(
                id=row["id"],
                name=row["name"],
                voice_description=row["voice_description"],
                created_at=datetime.fromisoformat(row["created_at"]),
                updated_at=datetime.fromisoformat(row["updated_at"]),
            )


async def list_maya_actors() -> list[MayaActor]:
    """List all Maya actors."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM maya_actors ORDER BY name") as cursor:
            rows = await cursor.fetchall()
            return [
                MayaActor(
                    id=row["id"],
                    name=row["name"],
                    voice_description=row["voice_description"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    updated_at=datetime.fromisoformat(row["updated_at"]),
                )
                for row in rows
            ]


async def update_maya_actor(
    actor_id: str,
    name: str | None = None,
    voice_description: str | None = None,
) -> MayaActor | None:
    """Update a Maya actor."""
    actor = await get_maya_actor(actor_id)
    if actor is None:
        return None

    now = datetime.utcnow()
    new_name = name if name is not None else actor.name
    new_voice_description = (
        voice_description if voice_description is not None else actor.voice_description
    )

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE maya_actors
            SET name = ?, voice_description = ?, updated_at = ?
            WHERE id = ?
            """,
            (new_name, new_voice_description, now, actor_id),
        )
        await db.commit()

    logger.info(f"Updated Maya actor: {new_name} ({actor_id})")

    return MayaActor(
        id=actor_id,
        name=new_name,
        voice_description=new_voice_description,
        created_at=actor.created_at,
        updated_at=now,
    )


async def delete_maya_actor(actor_id: str) -> bool:
    """Delete a Maya actor."""
    actor = await get_maya_actor(actor_id)
    if actor is None:
        return False

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM maya_actors WHERE id = ?", (actor_id,))
        await db.commit()

    logger.info(f"Deleted Maya actor: {actor.name} ({actor_id})")
    return True


# Video Job functions


async def create_video_job(
    job_id: str,
    model: str,
    prompt: str,
    resolution: str,
    aspect_ratio: str,
    num_frames: int,
    video_path: str,
    duration_seconds: float,
) -> VideoJob:
    """Create a video job record."""
    now = datetime.utcnow()

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO video_jobs
                (id, model, prompt, resolution, aspect_ratio, num_frames, video_path, duration_seconds, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (job_id, model, prompt, resolution, aspect_ratio, num_frames, video_path, duration_seconds, now, now),
        )
        await db.commit()

    logger.info(f"Created video job: {job_id}")

    return VideoJob(
        id=job_id,
        model=model,
        prompt=prompt,
        resolution=resolution,
        aspect_ratio=aspect_ratio,
        num_frames=num_frames,
        video_path=video_path,
        duration_seconds=duration_seconds,
        created_at=now,
        completed_at=now,
    )


async def get_video_job(job_id: str) -> VideoJob | None:
    """Get a video job by ID."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM video_jobs WHERE id = ?", (job_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row is None:
                return None
            return VideoJob(
                id=row["id"],
                model=row["model"],
                prompt=row["prompt"],
                resolution=row["resolution"],
                aspect_ratio=row["aspect_ratio"],
                num_frames=row["num_frames"],
                video_path=row["video_path"],
                duration_seconds=row["duration_seconds"],
                created_at=datetime.fromisoformat(row["created_at"]),
                completed_at=datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None,
            )


async def get_video_jobs(limit: int = 50, offset: int = 0) -> tuple[list[VideoJob], int]:
    """Get video jobs with pagination. Returns (videos, total_count)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Get total count
        async with db.execute("SELECT COUNT(*) FROM video_jobs") as cursor:
            row = await cursor.fetchone()
            total = row[0] if row else 0

        # Get paginated results
        async with db.execute(
            "SELECT * FROM video_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ) as cursor:
            rows = await cursor.fetchall()
            videos = [
                VideoJob(
                    id=row["id"],
                    model=row["model"],
                    prompt=row["prompt"],
                    resolution=row["resolution"],
                    aspect_ratio=row["aspect_ratio"],
                    num_frames=row["num_frames"],
                    video_path=row["video_path"],
                    duration_seconds=row["duration_seconds"],
                    created_at=datetime.fromisoformat(row["created_at"]),
                    completed_at=datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None,
                )
                for row in rows
            ]

    return videos, total


async def delete_video_job(job_id: str) -> bool:
    """Delete a video job record (does not delete files)."""
    job = await get_video_job(job_id)
    if job is None:
        return False

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM video_jobs WHERE id = ?", (job_id,))
        await db.commit()

    logger.info(f"Deleted video job: {job_id}")
    return True
