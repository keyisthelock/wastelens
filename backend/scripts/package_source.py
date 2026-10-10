"""Allowlisted Lambda source staging; never copy resident data or credentials."""
from pathlib import Path
import shutil
import sys

PUBLIC_DATA = ('authorities.json', 'pilot.json', 'recovery_routes.json', 'factors.json')


def stage(source, target):
    source, target = Path(source), Path(target)
    for module in (source / 'app').rglob('*.py'):
        if '__pycache__' in module.parts:
            continue
        destination = target / module.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(module, destination)
    (target / 'data').mkdir(parents=True, exist_ok=True)
    for name in PUBLIC_DATA:
        shutil.copy2(source / 'data' / name, target / 'data' / name)


if __name__ == '__main__':
    stage(Path(__file__).resolve().parents[1], sys.argv[1])
