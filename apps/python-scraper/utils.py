import io
import subprocess
import os

from telethon import TelegramClient
from telethon.tl.types import Channel


def get_repo_root():
    try:
        repo_root = subprocess.check_output(
            ['git', 'rev-parse', '--show-toplevel'],
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        return repo_root
    except subprocess.CalledProcessError:
        # Not in a git repo, fall back to current directory
        return os.getcwd()

def get_session_path():
    repo_root = get_repo_root()
    session_path = os.path.join(repo_root, "session")
    return session_path

def get_sqlite_db_path():
    repo_root = get_repo_root()
    db_path = os.path.join(repo_root, "bridge.db")
    return db_path


async def get_profile_picture_for_channel(client: TelegramClient, channel: Channel) -> bytes:
    """Fetch the profile picture of a Telegram channel as bytes."""
    photo_bytes = io.BytesIO()
    await client.download_profile_photo(channel, photo_bytes)
    
    # with open("profile_photo.jpg", "wb") as f:
    #     f.write(photo_bytes.getvalue())
    
    # print(len(photo_bytes.getvalue()))
    return photo_bytes.getvalue()

if __name__ == "__main__":
    _repo_root = get_repo_root()
    _session_path = os.path.join(_repo_root, "session")
    __session_path = get_session_path()
    assert _session_path == __session_path
    print(_session_path, os.path.exists(_session_path))
    
    sqlite_path = get_sqlite_db_path()
    print(sqlite_path, os.path.exists(sqlite_path))