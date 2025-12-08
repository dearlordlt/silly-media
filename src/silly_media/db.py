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

        await db.commit()

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
