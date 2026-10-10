"""Public resident-created Lucknow community directory; aliases are unverified."""
import hmac
from datetime import datetime, timezone
from fastapi import HTTPException
from app.storage import connect, hash_token
from app.aws_storage import configured

PUBLIC_FIELDS = ('id', 'name', 'area', 'description', 'creator', 'city', 'created_at')


def public_group(item):
    return {field: item[field] for field in PUBLIC_FIELDS}


def list_groups():
    if configured():
        from app.aws_storage import table
        from boto3.dynamodb.conditions import Key
        items = table().query(IndexName='ByLocalityAndCreatedAt',
            KeyConditionExpression=Key('gsi1pk').eq('COMMUNITIES#Lucknow'),
            ScanIndexForward=False, Limit=50).get('Items', [])
    else:
        with connect() as db:
            items = db.execute('SELECT * FROM communities ORDER BY created_at DESC,id DESC LIMIT 50').fetchall()
    return [public_group(item) for item in items]


def create_group(group_id, name, area, description, creator, token):
    item = dict(id=group_id, name=name, area=area, description=description,
                creator=creator, city='Lucknow', created_at=datetime.now(timezone.utc).isoformat(),
                client_token_hash=hash_token(token))
    if configured():
        from app.aws_storage import table
        from botocore.exceptions import ClientError
        target = table()
        key = {'pk': f'COMMUNITY#{group_id}', 'sk': 'META'}
        existing = target.get_item(Key=key, ConsistentRead=True).get('Item')
        if not existing:
            try:
                target.put_item(Item={**key, **item, 'gsi1pk': 'COMMUNITIES#Lucknow',
                                     'gsi1sk': item['created_at']}, ConditionExpression='attribute_not_exists(pk)')
            except ClientError as error:
                if error.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                    raise
                existing = target.get_item(Key=key, ConsistentRead=True).get('Item')
        if existing:
            item = existing
    else:
        with connect() as db:
            fields = (*PUBLIC_FIELDS, 'client_token_hash')
            db.execute('INSERT OR IGNORE INTO communities (id,name,area,description,creator,city,created_at,client_token_hash) VALUES (?,?,?,?,?,?,?,?)',
                       tuple(item[field] for field in fields))
            item = dict(db.execute('SELECT * FROM communities WHERE id=?', (group_id,)).fetchone())
    if not hmac.compare_digest(item['client_token_hash'], hash_token(token)):
        raise HTTPException(403, 'This community was created by another browser')
    if any(item[field] != value for field, value in [('name', name), ('area', area), ('description', description), ('creator', creator)]):
        raise HTTPException(409, 'This community is already saved with different details. Refresh before creating another.')
    return public_group(item)
