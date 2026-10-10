"""Optional atomic daily inference limit shared across Lambda instances."""
from datetime import datetime, timezone
import os


class AiBudgetUnavailable(RuntimeError):
    pass


def reserve_ai_call():
    """Count attempts before calling AWS; fail closed when the limit cannot be checked.

    This caps logical app operations, not dollars, retries, or calls made elsewhere.
    Local development is unchanged unless the environment enables the limit.
    """
    value = os.getenv('WASTELENS_AI_DAILY_LIMIT', '0')
    try:
        limit = int(value)
    except ValueError as exc:
        raise AiBudgetUnavailable('AI usage limit configuration is invalid') from exc
    if limit == 0:
        return
    if limit < 0:
        raise AiBudgetUnavailable('AI usage limit configuration is invalid')
    from app.aws_storage import table
    from botocore.exceptions import ClientError
    day = datetime.now(timezone.utc).date().isoformat()
    try:
        table().update_item(
            Key={'pk': 'AI_USAGE', 'sk': day},
            UpdateExpression='SET #used = if_not_exists(#used, :zero) + :one',
            ConditionExpression='attribute_not_exists(#used) OR #used < :limit',
            ExpressionAttributeNames={'#used': 'calls'},
            ExpressionAttributeValues={':zero': 0, ':one': 1, ':limit': limit},
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            raise AiBudgetUnavailable('Daily AI allowance reached; manual reporting remains available') from exc
        raise AiBudgetUnavailable('AI usage allowance could not be checked; try later') from exc
    except Exception as exc:
        raise AiBudgetUnavailable('AI usage allowance could not be checked; try later') from exc
