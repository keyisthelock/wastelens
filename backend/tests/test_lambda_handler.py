import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from app.lambda_handler import handler


class LambdaStagePathTests(unittest.TestCase):
    def invoke(self, path):
        event={
            'version':'2.0','routeKey':'GET /health','rawPath':path,'rawQueryString':'',
            'headers':{'host':'test.execute-api.ap-southeast-2.amazonaws.com','x-forwarded-proto':'https'},
            'requestContext':{'stage':'prod','http':{'method':'GET','path':path,'sourceIp':'127.0.0.1','protocol':'HTTP/1.1'},'requestId':'synthetic'},
            'body':None,'isBase64Encoded':False,
        }
        with patch('app.main.initialize'):
            return handler(event,SimpleNamespace(aws_request_id='synthetic'))

    def test_named_prod_stage_reaches_fastapi_health(self):
        response=self.invoke('/prod/health')
        self.assertEqual(response['statusCode'],200)
        self.assertEqual(json.loads(response['body']),{'ok':True})

    def test_unknown_route_is_still_not_found(self):
        self.assertEqual(self.invoke('/prod/unknown')['statusCode'],404)
