"""Operator-only AWS verification. Default: metadata reads; never deploy or email.
Run with backend/.venv/bin/python backend/scripts/aws_readiness.py.
Inference requires --allow-inference AND a consented, non-sensitive --photo.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services import MODEL_ID_DEFAULT, analyze_image, classify_waste_image
from app.image_security import normalize_uploaded_image


def check(operation, call):
    try:
        result = call()
        return {"operation": operation, "result": "verified_live", "data": result}
    except Exception as exc:
        # Never print SDK exception messages (may contain request data or identifiers).
        code = getattr(exc, "response", {}).get("Error", {}).get("Code", type(exc).__name__)
        return {"operation": operation, "result": "unavailable", "error_code": code}


def audit(profile=None, region=None, photo=None, allow_inference=False):
    import boto3
    from botocore.config import Config
    os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
    session = boto3.Session(profile_name=profile, region_name=region)
    region = session.region_name
    model = os.getenv("WASTELENS_BEDROCK_MODEL_ID", MODEL_ID_DEFAULT)
    results = {"region": region, "model": model,
               "tools": {"aws_cli": bool(shutil.which("aws")), "sam_cli": bool(shutil.which("sam")),
                         **{name: bool(importlib.util.find_spec(name)) for name in ["boto3", "strands", "PIL", "mangum"]}},
               "services": {}, "deployment_checked": False}
    if not region:
        results["blocker"] = "Configure AWS_REGION and a temporary authenticated AWS profile. No AWS requests made."
        return results
    credentials = session.get_credentials()
    if not credentials:
        results["blocker"] = "No AWS credentials found. No AWS requests made."
        return results
    frozen = credentials.get_frozen_credentials()
    if not frozen.token:
        results["blocker"] = "Use temporary session credentials, SSO or AWS CLI browser login; static keys are not accepted by this audit."
        return results
    config = Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 1})
    def client(service):
        return session.client(service, config=config)
    def identity():
        response = client("sts").get_caller_identity()
        arn = response["Arn"]
        if arn.endswith(":root"):
            raise RuntimeError("RootIdentityNotAllowed")
        return {"identity_type": "assumed_role" if ":assumed-role/" in arn else "temporary_session",
                "account_suffix": response["Account"][-4:]}
    results["services"]["identity"] = check("sts:GetCallerIdentity", identity)
    if results["services"]["identity"]["result"] != "verified_live":
        results["blocker"] = "Temporary non-root identity could not be verified."
        return results
    # Metadata describes capabilities; it does NOT prove InvokeModel permission.
    if ":" in model and not model.startswith("arn:") and not model.startswith(("us.", "eu.", "apac.", "global.", "in.", "jp.", "au.")):
        def model_metadata():
            details = client("bedrock").get_foundation_model(modelIdentifier=model)["modelDetails"]
            return {key: details.get(key) for key in ["modelId", "inputModalities", "outputModalities", "inferenceTypesSupported"]}
        results["services"]["bedrock_metadata"] = check("bedrock:GetFoundationModel", model_metadata)
    else:
        results["services"]["bedrock_metadata"] = check("bedrock:GetInferenceProfile", lambda: {
            "model_arns": [entry["modelArn"] for entry in client("bedrock").get_inference_profile(inferenceProfileIdentifier=model)["models"]]})
    bucket = os.getenv("WASTELENS_UPLOAD_BUCKET")
    table = os.getenv("WASTELENS_DYNAMODB_TABLE")
    results["services"]["s3"] = (check("s3:GetBucketPublicAccessBlock", lambda: client("s3").get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"])
                                      if bucket else {"result": "unavailable", "blocker": "WASTELENS_UPLOAD_BUCKET missing"})
    results["services"]["dynamodb"] = (check("dynamodb:DescribeTable", lambda: {
        "status": client("dynamodb").describe_table(TableName=table)["Table"]["TableStatus"]})
        if table else {"result": "unavailable", "blocker": "WASTELENS_DYNAMODB_TABLE missing"})
    for service in ["rekognition", "bedrock_inference"]:
        results["services"][service] = {"result": "not_checked", "blocker": "Inference needs an explicitly consented image and --allow-inference; metadata is not proof of runtime IAM access."}
    if allow_inference and photo:
        content_type = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(photo.suffix.lower(), "")
        normalized = normalize_uploaded_image(photo.read_bytes(), content_type)
        # The integrations use boto3's default session; select only this temporary profile.
        boto3.DEFAULT_SESSION = session
        os.environ["AWS_REGION"] = region
        for service, function in [("rekognition", analyze_image), ("bedrock_inference", classify_waste_image)]:
            response = function(normalized)
            results["services"][service] = {
                "operation": "DetectLabels + DetectModerationLabels" if service == "rekognition" else "Converse (image)",
                "result": "verified_live" if response["analysis_available"] else "unavailable", "response": response}
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--photo", type=Path)
    parser.add_argument("--allow-inference", action="store_true")
    args = parser.parse_args()
    if args.allow_inference != bool(args.photo):
        parser.error("Provide both --photo and --allow-inference to explicitly consent to image processing and AWS inference charges.")
    print(json.dumps(audit(**vars(args)), indent=2))
