import tempfile
from pathlib import Path
import unittest

from scripts.package_source import PUBLIC_DATA, stage


class PackagingTests(unittest.TestCase):
    def test_only_public_source_and_pilot_data_are_staged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'target'
            for folder in ['app', 'data', 'uploads', '.aws', 'app/__pycache__']:
                (source / folder).mkdir(parents=True, exist_ok=True)
            (source / 'app/main.py').write_text('app = None')
            for name in PUBLIC_DATA:
                (source / 'data' / name).write_text('{}')
            for name in ['data/wastelens.db', 'data/private.json', 'uploads/resident.jpg', '.aws/credentials', '.env', 'app/.env', 'app/private.txt', 'app/__pycache__/main.pyc']:
                (source / name).write_text('private sentinel')
            stage(source, target)
            actual = {str(path.relative_to(target)) for path in target.rglob('*') if path.is_file()}
            self.assertEqual(actual, {'app/main.py', *{'data/' + name for name in PUBLIC_DATA}})
