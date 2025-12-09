import os
import asyncio
from dotenv import load_dotenv
from telethon import TelegramClient, events
from telethon.sessions import StringSession

from utils import get_session_path

load_dotenv()

async def main():
    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.start()
    session = client.session.save()
    assert session is not None
    assert isinstance(session, str)
    session_path = get_session_path()
    with open(os.path.join(session_path, "apps", "python-scraper", "session"), "w") as f:
        f.write(session.strip())
    

if __name__ == "__main__":
    api_id = int(os.getenv("API_ID"))
    api_hash = os.getenv("API_HASH")

    asyncio.run(main())
