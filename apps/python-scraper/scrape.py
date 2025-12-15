"""
Telegram Scraper

This scraper uses a hybrid approach:
1. PRIMARY: Event-based listening via Telethon's @client.on(events.NewMessage)
   - Real-time message delivery (sub-second latency)
   - Efficient - Telegram pushes messages to us
   
2. FALLBACK: Periodic polling via cron (default every 10 minutes)
   - Catches any messages missed during brief disconnections
   - Uses cursor-based pagination to avoid duplicates
   - Only fetches messages newer than the last cursor

The scraper sends messages to the Express server for processing and
forwarding to Discord webhooks.

Required Environment Variables:
- API_ID: Telegram API ID from https://my.telegram.org
- API_HASH: Telegram API hash
- PROCESSOR_SERVER_LISTEN_URL: Express server base URL
- PROCESSOR_SERVER_POST_MSG_PATH: Path for message posting endpoint
- PROCESSOR_SERVER_TOKEN: Bearer token for authentication
- SQLITE_PATH: Path to the SQLite database
- DEFAULT_CRON: Cron expression for polling interval (default: "*/10 * * * *")
"""

import os
import asyncio
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, List, Any, Set
from dataclasses import dataclass

import aiohttp
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.types import Channel, Message
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from utils import get_repo_root, get_session_path, get_sqlite_db_path

# Load environment variables from .env file
load_dotenv()
# =======================================================
# Configuration
# =============================================================================

@dataclass
class Config:
    """Application configuration loaded from environment variables."""
    api_id: int
    api_hash: str
    server_url: str
    post_msg_path: str
    log_path: str
    token: str
    sqlite_path: str
    default_cron: str
    
    @classmethod
    def from_env(cls) -> 'Config':
        """Load configuration from environment variables."""
        api_id_str = os.getenv('API_ID')
        api_hash = os.getenv('API_HASH')
        server_url = os.getenv('PROCESSOR_SERVER_LISTEN_URL', 'http://localhost:6969')
        post_msg_path = os.getenv('PROCESSOR_SERVER_POST_MSG_PATH', 'process')
        log_path = os.getenv('PROCESSOR_SERVER_LOG_PATH', 'log')
        token = os.getenv('PROCESSOR_SERVER_TOKEN')
        sqlite_path = get_sqlite_db_path()
        default_cron = os.getenv('DEFAULT_CRON', '*/10 * * * *')
        
        # Validate required fields
        if not api_id_str:
            raise ValueError("API_ID environment variable is required")
        if not api_hash:
            raise ValueError("API_HASH environment variable is required")
        if not token:
            raise ValueError("PROCESSOR_SERVER_TOKEN environment variable is required")
        
        return cls(
            api_id=int(api_id_str),
            api_hash=api_hash,
            server_url=server_url.rstrip('/'),
            post_msg_path=post_msg_path,
            log_path=log_path,
            token=token,
            sqlite_path=sqlite_path,
            default_cron=default_cron
        )
    
    @property
    def process_url(self) -> str:
        """Full URL for the message processing endpoint."""
        return f"{self.server_url}/{self.post_msg_path}"
    
    @property
    def log_url(self) -> str:
        """Full URL for the logging endpoint."""
        return f"{self.server_url}/{self.log_path}"


# =============================================================================
# Result Types
# =============================================================================

@dataclass
class Ok:
    """Represents a successful result."""
    value: Any
    ok: bool = True

@dataclass
class Err:
    """Represents an error result."""
    error: str
    code: str = "UNKNOWN_ERROR"
    ok: bool = False

Result = Ok | Err


# =============================================================================
# Database Operations
# =============================================================================

class Database:
    """
    Database operations for the scraper.
    Uses SQLite with WAL mode for concurrent access with TypeScript processes.
    """
    
    def __init__(self, path: str):
        self.path = path
        self._connection: Optional[sqlite3.Connection] = None
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get or create a database connection."""
        if self._connection is None:
            # timeout=30 sets busy_timeout to 30 seconds for lock contention
            self._connection = sqlite3.connect(self.path, timeout=30.0)
            self._connection.row_factory = sqlite3.Row
            # Enable WAL mode for concurrent access
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA foreign_keys=ON")
        return self._connection
    
    def close(self):
        """Close the database connection."""
        if self._connection:
            self._connection.close()
            self._connection = None
    
    def get_active_subscribed_channel_for_id(self, channel_id: int) -> Result:
        """
        TODO: Add a way to refresh for a channel after adding it
        Get all telegram channels that have active webhook subscriptions.
        Returns channel records with their telegram_id and telegram_url.
        """
        try:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT DISTINCT tc.id, tc.telegram_id, tc.telegram_url, tc.telegram_username
                FROM telegram_channel tc
                INNER JOIN discord_webhook dw ON dw.telegram_channel_id = tc.id
                WHERE dw.is_active = 1 AND tc.id = ?
            """, (channel_id,))
            rows = cursor.fetchone()
            if len(rows) != 1:
                return Ok(None)
            return Ok(dict(rows[0]))
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")
        
    def get_active_subscribed_channels(self) -> Result:
        """
        Get all telegram channels that have active webhook subscriptions.
        Returns channel records with their telegram_id and telegram_url.
        """
        try:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT DISTINCT tc.id, tc.telegram_id, tc.telegram_url, tc.telegram_username
                FROM telegram_channel tc
                INNER JOIN discord_webhook dw ON dw.telegram_channel_id = tc.id
                WHERE dw.is_active = 1
            """)
            rows = cursor.fetchall()
            return Ok([dict(row) for row in rows])
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")
    
    def get_cursor_for_channel(self, telegram_channel_id: int) -> Result:
        """Get the message cursor for a specific channel."""
        try:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT id, telegram_channel_id, last_seen_msg_id, last_seen_msg_time
                FROM msg_cursor
                WHERE telegram_channel_id = ?
            """, (telegram_channel_id,))
            row = cursor.fetchone()
            if row:
                return Ok(dict(row))
            return Ok(None)
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")
    
    def update_telegram_channel_externals(
        self,
        telegram_channel_id: int,
        external_telegram_id: int,
        external_telegram_username: str
    ) -> Result:
        """Update a telegram channel record with new telegram_id and/or username."""
        try:
            conn = self._get_connection()

            # Check if this telegram_id already exists on a different channel
            existing = conn.execute("""
                SELECT id FROM telegram_channel
                WHERE telegram_id = ? AND id != ?
            """, (external_telegram_id, telegram_channel_id)).fetchone()

            if existing:
                # telegram_id already exists on another channel - this is a duplicate entry
                # Skip the update to avoid UNIQUE constraint violation
                print(f"  Warning: telegram_id {external_telegram_id} already exists on channel {existing['id']}, skipping update for channel {telegram_channel_id}")
                return Ok(None)

            now = datetime.now(timezone.utc).isoformat()
            conn.execute("""
                UPDATE telegram_channel
                SET telegram_id = COALESCE(?, telegram_id),
                    telegram_username = COALESCE(?, telegram_username),
                    updated_at = ?
                WHERE id = ?
            """, (external_telegram_id, external_telegram_username, now, telegram_channel_id))
            conn.commit()
            return Ok(None)
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")
    
    def update_cursor(
        self,
        telegram_channel_id: int,
        last_seen_msg_id: int,
        last_seen_msg_time: Optional[str] = None
    ) -> Result:
        """Update or create a cursor for a channel."""
        try:
            conn = self._get_connection()
            now = datetime.now(timezone.utc).isoformat()
            
            # Try to update existing cursor (only if new msg_id is greater)
            conn.execute("""
                INSERT INTO msg_cursor (telegram_channel_id, last_seen_msg_id, last_seen_msg_time, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(telegram_channel_id) DO UPDATE SET
                    last_seen_msg_id = MAX(msg_cursor.last_seen_msg_id, excluded.last_seen_msg_id),
                    last_seen_msg_time = COALESCE(excluded.last_seen_msg_time, msg_cursor.last_seen_msg_time),
                    updated_at = excluded.updated_at
            """, (telegram_channel_id, last_seen_msg_id, last_seen_msg_time, now, now))
            conn.commit()
            return Ok(None)
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")
    
    def get_general_config(self) -> Result:
        """Get the general configuration (cron setting)."""
        try:
            conn = self._get_connection()
            cursor = conn.execute("SELECT id, cron FROM general_config LIMIT 1")
            row = cursor.fetchone()
            if row:
                return Ok(dict(row))
            return Ok(None)
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")
    
    def resolve_channel_id(self, telegram_url: str, telegram_id: int, telegram_username: Optional[str]) -> Result:
        """Update a channel's telegram_id if it was null (resolved from API)."""
        try:
            conn = self._get_connection()
            now = datetime.now(timezone.utc).isoformat()
            conn.execute("""
                UPDATE telegram_channel
                SET telegram_id = ?, telegram_username = ?, updated_at = ?
                WHERE telegram_url = ? AND telegram_id IS NULL
            """, (telegram_id, telegram_username, now, telegram_url))
            conn.commit()
            return Ok(None)
        except Exception as e:
            return Err(str(e), "DB_QUERY_ERROR")


# =============================================================================
# Telegram Message Serialization
# =============================================================================

def serialize_message(message: Message) -> Dict[str, Any]:
    """
    Convert a Telethon Message object to a JSON-serializable dictionary.
    This format matches what the Express server expects.
    """
    return {
        'id': message.id,
        'date': message.date.isoformat() if message.date else None,
        'message': message.message,
        'views': message.views,
        'forwards': message.forwards,
        'edit_date': message.edit_date.isoformat() if message.edit_date else None,
        'post_author': message.post_author,
        # Serialize media info (type only, not full content)
        'media': str(type(message.media).__name__) if message.media else None,
        # Serialize entities (formatting)
        'entities': [
            {'type': type(e).__name__, 'offset': e.offset, 'length': e.length}
            for e in (message.entities or [])
        ] if message.entities else None,
        # Reply info
        'reply_to': message.reply_to.reply_to_msg_id if message.reply_to else None
    }


# =============================================================================
# HTTP Client
# =============================================================================

class HttpClient:
    """HTTP client for communicating with the Express server."""
    
    def __init__(self, config: Config):
        self.config = config
        self._session: Optional[aiohttp.ClientSession] = None
    
    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create an aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {self.config.token}'
                },
                timeout=aiohttp.ClientTimeout(total=30)
            )
        return self._session
    
    async def close(self):
        """Close the HTTP session."""
        if self._session and not self._session.closed:
            await self._session.close()
    
    async def send_messages(
        self,
        channel_id: int,
        channel_username: str,
        channel_url: str,
        messages: List[Dict[str, Any]]
    ) -> Result:
        """
        Send a batch of messages to the Express server for processing.
        """
        try:
            session = await self._get_session()
            
            payload = {
                'channelId': channel_id,
                'channelUsername': channel_username,
                'channelUrl': channel_url,
                'messages': messages
            }
            
            async with session.post(self.config.process_url, json=payload) as response:
                body = await response.json()
                
                if response.status == 200 and body.get('ok'):
                    return Ok({
                        'processed': body.get('processed', 0),
                        'pending': body.get('pending', 0)
                    })
                else:
                    error_msg = body.get('error', {}).get('message', 'Unknown error')
                    return Err(error_msg, "HTTP_ERROR")
                    
        except aiohttp.ClientError as e:
            return Err(f"HTTP client error: {e}", "HTTP_CLIENT_ERROR")
        except Exception as e:
            return Err(f"Unexpected error: {e}", "UNEXPECTED_ERROR")
    
    async def send_log(
        self,
        log_type: str,  # "info", "warning", "error", "debug"
        message: str,
        details: Optional[Dict[str, Any]] = None
    ) -> Result:
        pass    
        # """Send a log message to the Express server."""
        # try:
        #     session = await self._get_session()
        #
        #     payload = {
        #         'logType': log_type,
        #         'message': message,
        #         'timestamp': datetime.now(timezone.utc).isoformat(),
        #         'details': details or {}
        #     }
        #
        #     async with session.post(self.config.log_url, json=payload) as response:
        #         if response.status == 200:
        #             return Ok(None)
        #         else:
        #             return Err(f"Log request failed with status {response.status}", "HTTP_ERROR")
        #
        # except Exception as e:
        #     # Don't let logging errors crash the scraper
        #     print(f"Failed to send log: {e}", file=sys.stderr)
        #     return Err(str(e), "LOG_ERROR")


# =============================================================================
# Telegram Scraper
# =============================================================================

class TelegramScraper:
    """
    Main scraper class that coordinates Telegram event listening and polling.
    """
    
    def __init__(self, config: Config):
        self.config = config
        self.db = Database(config.sqlite_path)
        self.http = HttpClient(config)
        session_path = get_session_path()
        if not os.path.exists(session_path):
            raise FileNotFoundError("Telegram session file 'session' not found. You need to run setup_session.py first")
        with open(session_path, "r") as f:
            session_value = f.read().strip()
        self.client = TelegramClient(StringSession(session_value), config.api_id, config.api_hash)
        self.scheduler = AsyncIOScheduler()
        
        # Cache of active channel IDs for filtering events
        # Maps telegram_id -> channel_info dict
        self._active_channels: Dict[int, Dict[str, Any]] = {}
        self._refresh_lock = asyncio.Lock()  # Prevents concurrent refresh storms
        self._last_cache_refresh = datetime.min.replace(tzinfo=timezone.utc)
        self._cache_ttl_seconds = 30  # Refresh cache every 30 seconds

        # Message debouncing for batching
        self._pending_messages: Dict[int, List[Dict[str, Any]]] = {}  # channel_id -> messages
        self._pending_channel_info: Dict[int, Dict[str, Any]] = {}  # channel_id -> info
        self._first_message_time: Dict[int, datetime] = {}  # channel_id -> first msg time
        self._debounce_tasks: Dict[int, asyncio.Task] = {}  # channel_id -> debounce task
        self._debounce_lock = asyncio.Lock()
        self._debounce_ms = 1000  # 1 second
        self._max_wait_ms = 5000  # 5 seconds
        self._has_used_startup_grace_period_retry = False  # Only once per run
        
    async def start(self):
        """Start the scraper."""
        print("Starting Telegram scraper...")
        
        # Connect to Telegram
        await self.client.start()
        print("Connected to Telegram")
        
        # Refresh active channels cache
        await self._refresh_active_channels()
        
        # Register event handler
        self.client.add_event_handler(
            self._handle_new_message,
            events.NewMessage()
        )
        print("Event handler registered")
        
        # Set up polling scheduler
        await self._setup_scheduler()
        
        await asyncio.sleep(10)
        # Run initial catch-up to process any missed messages
        await self._catch_up_all_channels()
        
        print("Scraper started successfully")
    
    async def stop(self):
        """Stop the scraper gracefully."""
        print("Stopping scraper...")
        
        # Stop scheduler
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
        
        # Close connections
        await self.http.close()
        self.db.close()
        
        # Disconnect from Telegram
        await self.client.disconnect()
        
        print("Scraper stopped")
    
    async def run_forever(self):
        """Run the scraper until interrupted."""
        try:
            await self.start()
            print("Running... Press Ctrl+C to stop")
            await self.client.run_until_disconnected()
        except KeyboardInterrupt:
            print("\nInterrupted by user")
        finally:
            await self.stop()
    
    async def _refresh_active_channels(self):
        """Refresh the cache of active subscribed channels."""
        # Prevent concurrent refreshes - if already refreshing, just wait for it
        async with self._refresh_lock:
            # Double-check if still stale (another caller may have just refreshed)
            now = datetime.now(timezone.utc)
            if (now - self._last_cache_refresh).total_seconds() <= self._cache_ttl_seconds:
                return

            # Query database
            result = self.db.get_active_subscribed_channels()

            if not result.ok:
                print(f"Failed to get active channels: {result.error}", file=sys.stderr)
                await self.http.send_log(
                    "error",
                    f"Failed to get active channels: {result.error}",
                    {'error_code': result.code}
                )
                return

            async def handle_channel(channel: Dict[str, Any]) -> Optional[Dict[str, Any]]:
                telegram_id = channel.get('telegram_id')

                if telegram_id is not None:
                    return channel

                # Resolve channel (I/O happens here)
                resolved = await self._resolve_channel(channel['telegram_url'])
                if not resolved:
                    return None

                telegram_id = resolved["telegram_id"]
                telegram_username = resolved.get("username")

                if not telegram_id:
                    print(f"  Resolved channel has no telegram_id: {channel['telegram_url']}", file=sys.stderr)
                    return None

                # Persist to database (more I/O)
                update_result = self.db.update_telegram_channel_externals(
                    channel['id'],
                    telegram_id,
                    telegram_username
                )

                if not update_result.ok:
                    print(f"  Failed to update channel externals: {update_result.error}", file=sys.stderr)
                    await self.http.send_log(
                        "error",
                        f"Failed to update channel externals for {channel['telegram_url']}: {update_result.error}",
                        {'channel_id': channel['id'], 'telegram_id': telegram_id}
                    )

                channel['telegram_id'] = telegram_id
                return channel

            # Process all channels concurrently
            channels = await asyncio.gather(
                *(handle_channel(channel) for channel in result.value),
                return_exceptions=True  # Don't let one failure stop all channels
            )

            # Build new cache dictionary
            new_cache = {}
            for channel in channels:
                # Handle exceptions from gather
                if isinstance(channel, Exception):
                    print(f"  Error processing channel: {channel}", file=sys.stderr)
                    await self.http.send_log("error", f"Channel processing failed: {channel}")
                    continue

                if not channel or channel.get('telegram_id') is None:
                    continue

                new_cache[channel['telegram_id']] = channel

            # Atomic swap of cache (fix #3: no need for clear + update)
            self._active_channels = new_cache
            self._last_cache_refresh = datetime.now(timezone.utc)

            print(f"Refreshed active channels cache: {len(new_cache)} channels")
        
    async def _get_active_channel_ids(self) -> Set[int]:
        """
        Get the set of active channel IDs, refreshing cache if needed.
        """
        now = datetime.now(timezone.utc)

        # Check if cache needs refresh
        if (now - self._last_cache_refresh).total_seconds() > self._cache_ttl_seconds:
            await self._refresh_active_channels()

        # No lock needed - dict is atomically swapped in _refresh_active_channels
        return set(self._active_channels.keys())

    async def _flush_channel_messages(self, channel_id: int):
        """Flush all pending messages for a channel to the server."""
        async with self._debounce_lock:
            messages = self._pending_messages.pop(channel_id, [])
            print(f"[FLUSH] Channel {channel_id} - {len(messages)} messages")
            channel_info = self._pending_channel_info.pop(channel_id, None)
            del self._first_message_time[channel_id]
            del self._debounce_tasks[channel_id] # Clear task reference

        if not messages or not channel_info:
            return

        print(f"[BATCH] Sending {len(messages)} messages from {channel_info['username']}")

        result = await self.http.send_messages(
            channel_id=channel_id,
            channel_username=channel_info['username'],
            channel_url=channel_info['url'],
            messages=messages
        )

        if result.ok:
            print(f"  -> Sent to server: processed={result.value['processed']}, pending={result.value['pending']}")
        else:
            print(f"  -> Error: {result.error}", file=sys.stderr)
            await self.http.send_log("error", f"Failed to send batch: {result.error}")

    async def _schedule_flush(self, channel_id: int):
        """Wait for debounce period then flush."""
        try:
            await asyncio.sleep(math.floor(self._debounce_ms / 1000))
            await self._flush_channel_messages(channel_id)
        except asyncio.CancelledError:
            pass  # Timer was reset by new message

    async def _handle_new_message(self, event):
        """
        Event handler for new messages with debouncing.
        Collects messages for 1 second before sending, with 5 second max wait.
        """
        try:
            # Get the chat/channel info
            chat = await event.get_chat()

            # Only process messages from channels
            if not isinstance(chat, Channel):
                return

            chat_id = chat.id

            # Check if this channel is in our active subscriptions
            active_ids = await self._get_active_channel_ids()

            if chat_id not in active_ids:
                # Not subscribed to this channel
                return

            # Get channel info from cache
            channel_info = self._active_channels.get(chat_id)

            if not channel_info:
                return

            # Serialize the message
            message = event.message
            serialized = serialize_message(message)

            print(f"[EVENT] New message {message.id} from {chat.username or chat_id}")

            async with self._debounce_lock:
                now = datetime.now(timezone.utc)

                # First message for this channel in batch
                if chat_id not in self._pending_messages:
                    self._pending_messages[chat_id] = []
                    self._first_message_time[chat_id] = now
                    self._pending_channel_info[chat_id] = {
                        'username': chat.username or str(chat_id),
                        'url': channel_info.get('telegram_url', f'https://t.me/{chat.username}')
                    }

                self._pending_messages[chat_id].append(serialized)

                # Check max wait time
                elapsed_ms = (now - self._first_message_time[chat_id]) / timedelta(milliseconds=1)
                if elapsed_ms >= self._max_wait_ms:
                    # Cancel timer and flush immediately
                    if chat_id in self._debounce_tasks:
                        self._debounce_tasks[chat_id].cancel()
                    # Create task to flush (releases lock first)
                    asyncio.create_task(self._flush_channel_messages(chat_id))
                    return

                # Reset debounce timer
                if chat_id in self._debounce_tasks:
                    self._debounce_tasks[chat_id].cancel()

                self._debounce_tasks[chat_id] = asyncio.create_task(
                    self._schedule_flush(chat_id)
                )

        except Exception as e:
            print(f"Error handling new message: {e}", file=sys.stderr)
            await self.http.send_log("error", f"Event handler error: {e}")
    
    async def _catch_up_all_channels(self):
        """
        Catch-up mechanism: fetch and process any messages missed during downtime.
        Uses cursors to avoid re-processing already-seen messages.
        """
        print("Running catch-up for all channels...")
        
        result = self.db.get_active_subscribed_channels()
        if not result.ok:
            print(f"Failed to get channels for catch-up: {result.error}", file=sys.stderr)
            await self.http.send_log(
                "error",
                f"Failed to get channels for catch-up: {result.error}",
                {'error_code': result.code}
            )
            return
        
        channels = result.value
        
        for channel_info in channels:
            await self._catch_up_channel(channel_info)
    
    async def _catch_up_channel(self, channel_info: Dict[str, Any], offset_mins: int = 60):
        """
        Catch up a single channel by fetching messages newer than the cursor.
        Fetches newest first, then reverses to send in chronological order.
        Always limits to messages from the last offset_mins (default 1 hour),
        regardless of cursor position.
        """
        channel_id = channel_info.get('id')
        telegram_id = channel_info.get('telegram_id')
        telegram_url = channel_info.get('telegram_url')

        # If we don't have a telegram_id, we need to resolve it
        if not telegram_id:
            resolved = await self._resolve_channel(telegram_url)
            if not resolved:
                # _resolve_channel already logs the error
                return
            telegram_id = resolved['telegram_id']

            # Update the database with resolved ID
            resolve_result = self.db.resolve_channel_id(
                telegram_url,
                telegram_id,
                resolved.get('username')
            )
            if not resolve_result.ok:
                print(f"  Failed to save resolved channel ID: {resolve_result.error}", file=sys.stderr)
                await self.http.send_log(
                    "error",
                    f"Failed to save resolved channel ID for {telegram_url}: {resolve_result.error}",
                    {'telegram_url': telegram_url, 'telegram_id': telegram_id}
                )
                # Continue anyway - we have the ID in memory for this session

            # Update channel_info for this session
            channel_info['telegram_id'] = telegram_id

        # Get cursor for this channel
        cursor_result = self.db.get_cursor_for_channel(channel_id)
        min_id = 0
        has_cursor = False

        if cursor_result.ok and cursor_result.value:
            min_id = cursor_result.value.get('last_seen_msg_id', 0)
            has_cursor = min_id > 0
        elif not cursor_result.ok:
            print(f"  Failed to get cursor for channel {channel_id}: {cursor_result.error}", file=sys.stderr)
            await self.http.send_log(
                "warning",
                f"Failed to get cursor for channel, starting from 0: {cursor_result.error}",
                {'channel_id': channel_id, 'telegram_url': telegram_url}
            )

        # Always limit to messages from the last offset_mins, regardless of cursor
        offset_date = datetime.now(timezone.utc)
        cutoff_time = offset_date - timedelta(minutes=offset_mins)

        if has_cursor:
            print(f"Catching up channel {telegram_url} (id={telegram_id}, min_id={min_id}, last {offset_mins} min)")
        else:
            print(f"Catching up channel {telegram_url} (id={telegram_id}, no cursor, last {offset_mins} min)")

        # Extract username from URL to use with Telethon
        # Telethon needs either a username or a resolved entity, not just the numeric ID
        username_match = re.search(r't\.me/([a-zA-Z0-9_]+)', telegram_url)
        entity_ref = username_match.group(1) if username_match else telegram_id

        try:
            # Fetch messages newest first, then reverse for chronological order
            messages = []

            async for message in self.client.iter_messages(
                entity_ref,
                min_id=min_id,
                offset_date=offset_date,
                reverse=False  # Newest first (default)
            ):
                # Stop when we hit messages older than the cutoff time
                if message.date < cutoff_time:
                    break

                messages.append(serialize_message(message))

            # Reverse to get chronological order (oldest first)
            messages.reverse()

            # Send in batches of 50
            for i in range(0, len(messages), 50):
                batch = messages[i:i + 50]
                await self._send_message_batch(channel_info, telegram_id, batch)

            print(f"  Catch-up complete for {telegram_url} ({len(messages)} messages)")

        except Exception as e:
            print(f"  Error during catch-up: {e}", file=sys.stderr)
            await self.http.send_log("error", f"Catch-up error for {telegram_url}: {e}")
    
    async def _send_message_batch(
        self,
        channel_info: Dict[str, Any],
        telegram_id: int,
        messages: List[Dict[str, Any]]
    ):
        """Send a batch of messages to the server."""
        if not messages:
            return
        
        # Get username from Telegram if not in our records
        username = channel_info.get('telegram_username', '')
        if not username:
            try:
                entity = await self.client.get_entity(telegram_id)
                if hasattr(entity, 'username') and entity.username:
                    username = entity.username
            except Exception as e:
                # Non-critical - we can still send with numeric ID as username
                print(f"  Could not fetch entity for username lookup: {e}", file=sys.stderr)
                username = str(telegram_id)
                
        
        result = await self.http.send_messages(
            channel_id=telegram_id,
            channel_username=username,
            channel_url=channel_info.get('telegram_url', f'https://t.me/{username}'),
            messages=messages
        )
        if not result.ok and not self._has_used_startup_grace_period_retry:
            self._has_used_startup_grace_period_retry = True
            await asyncio.sleep(5)
            result = await self.http.send_messages(
                channel_id=telegram_id,
                channel_username=username,
                channel_url=channel_info.get('telegram_url', f'https://t.me/{username}'),
                messages=messages
            )
            
        if result.ok:
            print(f"  Sent batch of {len(messages)} messages: processed={result.value['processed']}")
        else:
            await asyncio.sleep(5)
            print(f"  Error sending batch: {result.error}", file=sys.stderr)
            await self.http.send_log(
                "error",
                f"Failed to send message batch: {result.error}",
                {'telegram_id': telegram_id, 'message_count': len(messages)}
            )
    
    async def _resolve_channel(self, telegram_url: str) -> Optional[Dict[str, Any]]:
        """
        Resolve a Telegram URL to get the channel entity and ID.
        """
        try:
            # Extract username from URL
            # Handles: https://t.me/username, t.me/username, @username
            
            # Check URL type first
            if '/joinchat/' in telegram_url or '/+' in telegram_url:
                raise Exception("This is a private invite link, not a public username")
            
            # Extract username from public URL
            username_match = re.search(r't\.me/([a-zA-Z0-9_]+)', telegram_url)
            if not username_match:
                raise Exception(f"Username not found in URL: {telegram_url}")
            
            username = username_match.group(1)
            
            # These aren't real usernames, they're URL path indicators
            if username in ['joinchat', 'addlist', 's', 'c']:
                raise Exception(f"Invalid username extracted from URL: {username}")
            
            
            # username = telegram_url.split('/')[-1].lstrip('@')
            
            # Get entity from Telegram
            entity = await self.client.get_entity(username)
            
            if isinstance(entity, Channel):
                return {
                    'telegram_id': entity.id,
                    'username': entity.username
                }
            
            # Not a channel - log and return None
            await self.http.send_log(
                "warning",
                f"Resolved entity for {telegram_url} is not a Channel",
                {'entity_type': type(entity).__name__}
            )
            return None
            
        except Exception as e:
            print(f"Failed to resolve channel {telegram_url}: {e}", file=sys.stderr)
            await self.http.send_log(
                "error",
                f"Failed to resolve channel {telegram_url}: {e}",
                {'telegram_url': telegram_url}
            )
            return None
    
    async def _setup_scheduler(self):
        """Set up the periodic polling scheduler."""
        # Get cron from config/database
        config_result = self.db.get_general_config()
        cron_expression = self.config.default_cron
        
        if config_result.ok and config_result.value:
            db_cron = config_result.value.get('cron')
            if db_cron:
                cron_expression = db_cron
        elif not config_result.ok:
            print(f"Failed to get config from database: {config_result.error}", file=sys.stderr)
            await self.http.send_log(
                "warning",
                f"Failed to get cron config from database, using default: {config_result.error}",
                {'default_cron': self.config.default_cron}
            )
        
        print(f"Setting up polling scheduler with cron: {cron_expression}")
        
        # Parse cron expression
        # Format: minute hour day month day_of_week
        parts = cron_expression.split()
        if len(parts) != 5:
            error_msg = f"Invalid cron expression: {cron_expression}"
            print(error_msg, file=sys.stderr)
            await self.http.send_log(
                "error",
                error_msg,
                {'cron_expression': cron_expression, 'parts_count': len(parts)}
            )
            return
        
        try:
            trigger = CronTrigger(
                minute=parts[0],
                hour=parts[1],
                day=parts[2],
                month=parts[3],
                day_of_week=parts[4]
            )
            
            # Add job
            self.scheduler.add_job(
                self._polling_job,
                trigger=trigger,
                id='polling_job',
                replace_existing=True
            )
            
            # Start scheduler
            self.scheduler.start()
            print("Polling scheduler started")
            
        except Exception as e:
            print(f"Failed to setup scheduler: {e}", file=sys.stderr)
            await self.http.send_log(
                "error",
                f"Failed to setup polling scheduler: {e}",
                {'cron_expression': cron_expression}
            )
    
    async def _polling_job(self):
        """
        Periodic polling job that catches up on any missed messages.
        This runs in addition to event-based listening as a safety net.
        """
        print("[POLL] Running scheduled polling...")
        
        try:
            # Refresh active channels first
            await self._refresh_active_channels()
            
            # Run catch-up
            await self._catch_up_all_channels()
            
            print("[POLL] Polling complete")
            
        except Exception as e:
            print(f"[POLL] Error during polling job: {e}", file=sys.stderr)
            await self.http.send_log(
                "error",
                f"Polling job failed: {e}",
                {'error_type': type(e).__name__}
            )


# =============================================================================
# Main Entry Point
# =============================================================================

async def main():
    """Main entry point."""
    try:
        config = Config.from_env()
        scraper = TelegramScraper(config)
        await scraper.run_forever()
    except ValueError as e:
        print(f"Configuration error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(main())