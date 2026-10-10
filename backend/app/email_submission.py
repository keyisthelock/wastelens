"""Optional, confirmation-gated complaint email delivery through Amazon SES."""

import os
import re


EMAIL_RE = re.compile(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$")


def sender_configuration():
    sender = os.getenv("WASTELENS_COMPLAINT_EMAIL_FROM", "").strip()
    region = (os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "").strip()
    valid = bool(sender and EMAIL_RE.fullmatch(sender) and region)
    return {"configured": valid, "sender": sender if valid else "", "region": region if valid else ""}


def send_complaint_email(*, sender, recipient, report, approved_draft):
    """Send a plain-text message to the directory recipient; never falls back locally."""
    import boto3

    region = (os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "").strip()
    if not region:
        raise RuntimeError("AWS region is not configured")

    categories = ", ".join(report.get("categories") or []) or "not assessed"
    severity = report.get("severity") or "unassessed"
    subject = f"WasteLens community report {report['id'][:8].upper()} · review requested"
    body = (
        "A Lucknow resident reviewed and approved the complaint text below for email.\n\n"
        f"WasteLens report ID: {report['id']}\n"
        f"Reported location: {report.get('address') or 'address not provided'}\n"
        f"Reported coordinates: {report['latitude']:.5f}, {report['longitude']:.5f}\n"
        f"Resident-recorded waste categories: {categories}\n"
        f"Resident-recorded severity: {severity} (resident estimate; please verify)\n\n"
        "Resident-approved complaint text:\n"
        f"{approved_draft.strip()}\n\n"
        "This message is addressed to the Lucknow Nagar Nigam public contact email listed in its official directory. "
        "That address is not identified as a complaint ticket inbox. Email delivery does not guarantee receipt, "
        "acknowledgment, ticket creation, or cleanup. No photo or reporter email address is attached.\n"
    )
    response = boto3.client("ses", region_name=region).send_email(
        Source=sender,
        Destination={"ToAddresses": [recipient]},
        Message={
            "Subject": {"Data": subject, "Charset": "UTF-8"},
            "Body": {"Text": {"Data": body, "Charset": "UTF-8"}},
        },
    )
    message_id = response.get("MessageId")
    if not message_id:
        raise RuntimeError("Amazon SES returned no message identifier")
    return message_id
