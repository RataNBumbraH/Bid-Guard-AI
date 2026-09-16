import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")

# Initialize Motor client
client = AsyncIOMotorClient(MONGO_URI)

# Database and Collection names
db = client.bidguard_ai
audits_collection = db.get_collection("audit_logs")