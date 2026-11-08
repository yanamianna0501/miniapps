"""Read only the active model configuration; stdout is a private pipe to Node, never a log."""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
import yaml


def main():
    root = Path(sys.argv[1])
    with (root / 'config.yaml').open(encoding='utf-8') as stream:
        config = yaml.safe_load(stream)
    if not isinstance(config, dict):
        raise ValueError('invalid_config')
    items = []
    for section in ('provider', 'custom_provider'):
        for key, value in (config.get(section) or {}).items():
            if not isinstance(value, dict):
                raise ValueError('invalid_provider')
            definitions = value.get('models') or {}
            ids = list(dict.fromkeys([*definitions, *(value.get('whitelist') or [])]))
            options = value.get('options') or {}
            models = []
            for model_id in ids:
                model = definitions.get(model_id) or {}
                models.append({'id': model_id, 'name': model.get('name', model_id),
                               'enabled': value.get('enabled', True) and model.get('enabled', True),
                               'contextWindow': (model.get('limit') or {}).get('context')})
            items.append({'id': key, 'name': value.get('name', key),
                          'enabled': value.get('enabled', True), 'models': models,
                          'baseURL': options.get('baseURL', ''),
                          'apiKey': options.get('apiKey', '')})
    if not items:
        raise ValueError('providers_missing')
    print(json.dumps({'providers': items}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not print exception values: YAML errors can contain a secret source line.
        sys.stderr.write('configuration_read_failed\n')
        sys.exit(1)
