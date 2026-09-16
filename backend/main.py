import os
import json
import io
from typing import List
from datetime import datetime

from PIL import Image, UnidentifiedImageError
import fitz  # PyMuPDF
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel 
from prompts.prompt import COMPLIANCE_PROMPT_TEMPLATE, VISION_JSON_INSTRUCTION
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

app = FastAPI(title="BidGuard AI Backend")

# ---------------------------------------------------------
# CORS
# ---------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# Database (MongoDB Atlas)
# ---------------------------------------------------------
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
client = AsyncIOMotorClient(MONGO_URI)
db = client.bidguard_ai
audits_collection = db.get_collection("audit_logs")

# ---------------------------------------------------------
# Gemini (Using the new google-genai SDK)
# ---------------------------------------------------------
GEMINI_API_KEY = os.getenv("BidGuard_AI")
if not GEMINI_API_KEY:
    raise ValueError("BidGuard_AI key is not set in environment variables or .env file.")

# Initialize the new GenAI client
ai_client = genai.Client(api_key=GEMINI_API_KEY)

MODEL_NAME = "gemini-3.6-flash"

SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
}

SUPPORTED_IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}


class ComplianceResponse(BaseModel):
    compliance_score: int
    risk_level: str
    missing_requirements: list[str]
    discrepancies: list[str]
    recommendation: str
    file_name: str = "document"


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------
def clean_json_response(text: str) -> dict:
    """Convert Gemini's response into a Python JSON object."""
    clean_text = (text or "").strip()

    if clean_text.startswith("```json"):
        clean_text = clean_text[7:]
    elif clean_text.startswith("```"):
        clean_text = clean_text[3:]

    if clean_text.endswith("```"):
        clean_text = clean_text[:-3]

    clean_text = clean_text.strip()

    # Handle accidental extra text around a JSON object.
    start = clean_text.find("{")
    end = clean_text.rfind("}")
    if start != -1 and end != -1 and end > start:
        clean_text = clean_text[start:end + 1]

    try:
        return json.loads(clean_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Gemini returned invalid JSON: {clean_text[:1000]}") from exc


def normalize_image_to_jpeg(file_bytes: bytes) -> bytes:
    """
    Convert browser-uploaded image formats into JPEG bytes.
    This makes TIFF/BMP/WEBP and unusual image files reliable for Gemini.
    """
    try:
        image = Image.open(io.BytesIO(file_bytes))
        image.load()

        # Handle transparency safely.
        if image.mode in ("RGBA", "LA"):
            background = Image.new("RGB", image.size, "white")
            background.paste(image, mask=image.getchannel("A"))
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")

        output = io.BytesIO()
        image.save(output, format="JPEG", quality=92, optimize=True)
        return output.getvalue()

    except UnidentifiedImageError as exc:
        raise ValueError("The uploaded file is not a valid/recognized image.") from exc


def analyze_pdf(file_bytes: bytes, tender_id: str):
    """
    For PDFs:
    - use extracted text when available
    - otherwise render PDF pages to images and use Gemini vision
    """
    doc = fitz.open(stream=file_bytes, filetype="pdf")

    try:
        extracted_text = "\n".join(page.get_text() for page in doc).strip()

        # Text PDF: keep the existing text-analysis path.
        if extracted_text:
            prompt = COMPLIANCE_PROMPT_TEMPLATE.format(
                tender_id=tender_id,
                extracted_text=extracted_text[:12000],
            )
            return ai_client.models.generate_content(
                model=MODEL_NAME,
                contents=prompt,
            )

        # Scanned/image-only PDF: use vision using the new SDK types/parts structure.
        contents = []
        vision_prompt = VISION_JSON_INSTRUCTION.format(tender_id=tender_id)
        contents.append(vision_prompt)

        for page in doc:
            pix = page.get_pixmap(dpi=160, alpha=False)
            image_bytes = pix.tobytes("jpeg")
            contents.append(
                genai.types.Part.from_bytes(
                    data=image_bytes,
                    mime_type="image/jpeg",
                )
            )

        return ai_client.models.generate_content(
            model=MODEL_NAME,
            contents=contents,
        )

    finally:
        doc.close()


def analyze_image(file_bytes: bytes, filename: str, tender_id: str):
    """Analyze PNG/JPG/JPEG/WEBP/BMP/TIFF images using Gemini vision via the new SDK."""
    normalized_bytes = normalize_image_to_jpeg(file_bytes)
    vision_prompt = VISION_JSON_INSTRUCTION.format(tender_id=tender_id)

    image_part = genai.types.Part.from_bytes(
        data=normalized_bytes,
        mime_type="image/jpeg",
    )

    return ai_client.models.generate_content(
        model=MODEL_NAME,
        contents=[vision_prompt, image_part],
    )


def analyze_file(file_bytes: bytes, filename: str, tender_id: str):
    extension = os.path.splitext(filename.lower())[1]

    if extension == ".pdf":
        return analyze_pdf(file_bytes, tender_id)

    if extension in SUPPORTED_IMAGE_MIMES:
        return analyze_image(file_bytes, filename, tender_id)

    raise HTTPException(
        status_code=400,
        detail=(
            "Unsupported file type. Supported formats: "
            "PDF, PNG, JPG, JPEG, WEBP, BMP, TIF and TIFF."
        ),
    )


def build_result(response, filename: str) -> dict:
    if not response or not getattr(response, "text", None):
        raise ValueError("Gemini returned an empty response.")

    result_data = clean_json_response(response.text)

    # Make sure the response always has the expected fields.
    result_data.setdefault("compliance_score", 0)
    result_data.setdefault("risk_level", "HIGH")
    result_data.setdefault("missing_requirements", [])
    result_data.setdefault("discrepancies", [])
    result_data.setdefault("recommendation", "Unable to generate a recommendation.")

    result_data["file_name"] = filename
    return result_data


# ---------------------------------------------------------
# Single document verification
# ---------------------------------------------------------
@app.post("/verify", response_model=ComplianceResponse)
async def verify_bid(
    file: UploadFile = File(...),
    tender_id: str = Form(...),
):
    filename = file.filename or "document"
    extension = os.path.splitext(filename.lower())[1]

    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported file type. Please upload PDF, PNG, JPG, JPEG, "
                "WEBP, BMP, TIF or TIFF."
            ),
        )

    try:
        file_bytes = await file.read()

        if not file_bytes:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        response = analyze_file(file_bytes, filename, tender_id)
        result = build_result(response, filename)

        # Save verification record to MongoDB Atlas
        audit_record = {
            "tender_id": tender_id,
            "file_name": filename,
            "compliance_score": result.get("compliance_score", 0),
            "risk_level": result.get("risk_level", "UNKNOWN"),
            "missing_requirements": result.get("missing_requirements", []),
            "discrepancies": result.get("discrepancies", []),
            "recommendation": result.get("recommendation", ""),
            "timestamp": datetime.utcnow()
        }
        await audits_collection.insert_one(audit_record)

        return result

    except HTTPException:
        raise
    except Exception as exc:
        print(f"Error processing {filename}: {exc}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to analyze {filename}: {str(exc)}",
        )


# ---------------------------------------------------------
# Batch verification - PDFs + images together
# ---------------------------------------------------------
@app.post("/verify-batch", response_model=List[ComplianceResponse])
async def verify_batch(
    files: List[UploadFile] = File(...),
    tender_id: str = Form(...),
):
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    results = []
    errors = []

    for file in files:
        filename = file.filename or "document"
        extension = os.path.splitext(filename.lower())[1]

        if extension not in SUPPORTED_EXTENSIONS:
            errors.append(f"{filename}: unsupported file type")
            continue

        try:
            file_bytes = await file.read()

            if not file_bytes:
                errors.append(f"{filename}: file is empty")
                continue

            response = analyze_file(file_bytes, filename, tender_id)
            result = build_result(response, filename)
            results.append(result)

            # Save each batch audit record to MongoDB Atlas
            audit_record = {
                "tender_id": tender_id,
                "file_name": filename,
                "compliance_score": result.get("compliance_score", 0),
                "risk_level": result.get("risk_level", "UNKNOWN"),
                "missing_requirements": result.get("missing_requirements", []),
                "discrepancies": result.get("discrepancies", []),
                "recommendation": result.get("recommendation", ""),
                "timestamp": datetime.utcnow()
            }
            await audits_collection.insert_one(audit_record)

        except Exception as exc:
            print(f"Error processing {filename}: {exc}")
            errors.append(f"{filename}: {str(exc)}")

    if not results:
        detail = "No files could be processed."
        if errors:
            detail += " | " + " | ".join(errors)
        raise HTTPException(status_code=500, detail=detail)

    return results


# ---------------------------------------------------------
# Fetch History Endpoint
# ---------------------------------------------------------
@app.get("/audit-history")
async def get_audit_history():
    history = []
    cursor = audits_collection.find().sort("timestamp", -1).limit(50)
    async for document in cursor:
        document["_id"] = str(document["_id"])
        history.append(document)
    return history


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "BidGuard AI",
        "model": MODEL_NAME,
        "supported_formats": sorted(SUPPORTED_EXTENSIONS),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )