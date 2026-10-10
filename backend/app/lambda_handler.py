from mangum import Mangum
import os

from app.main import app

handler = Mangum(app, lifespan="auto", api_gateway_base_path=os.getenv("WASTELENS_API_BASE_PATH", "/prod"))
