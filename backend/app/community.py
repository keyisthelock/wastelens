"""Small report discussion repository; public aliases are not verified identities."""
import hmac
from datetime import datetime, timezone
from fastapi import HTTPException
from app.storage import connect, hash_token
from app.aws_storage import configured


def _visible(item, token):
    item = dict(item)
    secret = item.pop('client_token_hash', '')
    item.pop('pk', None)
    item.pop('sk', None)
    item.pop('gsi1pk', None)
    item.pop('gsi1sk', None)
    item['is_author'] = bool(token and hmac.compare_digest(secret, hash_token(token)))
    return item


def list_comments(report_id, token=None):
    if configured():
        from app.aws_storage import table
        from boto3.dynamodb.conditions import Key
        # Most recent 100 comments; paginate only within a report's discussion.
        response = table().query(IndexName='ByLocalityAndCreatedAt', KeyConditionExpression=Key('gsi1pk').eq(f'DISCUSSION#{report_id}'),
                                 ScanIndexForward=False, Limit=100)
        items = response.get('Items', [])
    else:
        with connect() as db:
            items = db.execute('SELECT * FROM comments WHERE report_id=? ORDER BY created_at DESC,id DESC LIMIT 100', (report_id,)).fetchall()
    return sorted((_visible(item, token) for item in items), key=lambda item: (item['created_at'], item['id']))


def save_comment(report_id, comment_id, author, body, token):
    item = {'report_id': report_id, 'id': comment_id, 'author': author, 'body': body,
            'client_token_hash': hash_token(token), 'created_at': datetime.now(timezone.utc).isoformat()}
    if configured():
        from app.aws_storage import table
        from botocore.exceptions import ClientError
        target = table()
        key = {'pk': f'REPORT#{report_id}', 'sk': f'COMMENT#{comment_id}'}
        # UUID key gives idempotency independently from response delivery.
        existing = target.get_item(Key=key, ConsistentRead=True).get('Item')
        if not existing:
            try:
                target.put_item(Item={**key, **item, 'gsi1pk': f'DISCUSSION#{report_id}', 'gsi1sk': item['created_at']}, ConditionExpression='attribute_not_exists(pk)')
            except ClientError as error:
                if error.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                    raise
                existing = target.get_item(Key=key, ConsistentRead=True).get('Item')
        if existing:
            item = existing
    else:
        with connect() as db:
            db.execute('INSERT OR IGNORE INTO comments (report_id,id,author,body,client_token_hash,created_at) VALUES (?,?,?,?,?,?)',
                       tuple(item[key] for key in ('report_id','id','author','body','client_token_hash','created_at')))
            item = dict(db.execute('SELECT * FROM comments WHERE report_id=? AND id=?', (report_id, comment_id)).fetchone())
    if not hmac.compare_digest(item['client_token_hash'], hash_token(token)):
        raise HTTPException(403, 'This discussion message belongs to a different browser')
    if item['author'] != author or item['body'] != body:
        raise HTTPException(409, 'This message is already saved with different text. Refresh the discussion before posting again.')
    return _visible(item, token)


def remove_comment(report_id, comment_id, token, moderator=False):
    if configured():
        from app.aws_storage import table
        from botocore.exceptions import ClientError
        key = {'pk': f'REPORT#{report_id}', 'sk': f'COMMENT#{comment_id}'}
        target = table()
        existing = target.get_item(Key=key, ConsistentRead=True).get('Item')
        if not existing:
            raise HTTPException(404, 'Discussion message not found')
        if not moderator and not (token and hmac.compare_digest(existing['client_token_hash'], hash_token(token))):
            raise HTTPException(403, 'Only the message author or report owner can remove it')
        target.delete_item(Key=key)
    else:
        with connect() as db:
            existing = db.execute('SELECT client_token_hash FROM comments WHERE report_id=? AND id=?', (report_id, comment_id)).fetchone()
            if not existing:
                raise HTTPException(404, 'Discussion message not found')
            if not moderator and not (token and hmac.compare_digest(existing['client_token_hash'], hash_token(token))):
                raise HTTPException(403, 'Only the message author or report owner can remove it')
            db.execute('DELETE FROM comments WHERE report_id=? AND id=?', (report_id, comment_id))
