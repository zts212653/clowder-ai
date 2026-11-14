"""Execute the first-party installer with empty model cache and CPU-only pip/downloader doubles."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent
DEPLOYMENT = SOURCE.parents[1] / 'packages/api/runtime/services/embedding-generations.json'


class FreshGenerationInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='embedding-fresh-install-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.scripts = self.root / 'scripts/services'
        self.scripts.mkdir(parents=True)
        for name in ['embed-install.sh', 'install-template.sh', 'proxy-env.sh', 'embedding_generation.py', 'embedding_generation_install.py']:
            if (SOURCE / name).exists():
                shutil.copyfile(SOURCE / name, self.scripts / name)
        (self.scripts / 'prereq-check.sh').write_text('''
check_python3() { PYTHON3="$FIXTURE_PYTHON"; RESOLVED_PYTHON_ARCH=arm64; }
check_disk_space() { :; }
check_network() { :; }
''')
        self.modules = self.root / 'modules'
        self.modules.mkdir()
        self.cache = self.root / 'hf-cache'
        self.cache.mkdir()
        self.log = self.root / 'commands.jsonl'
        # Fixtures replace transport/packages, never the identity verifier.
        (self.modules / 'sitecustomize.py').write_text("import platform\nplatform.system=lambda:'Darwin'\nplatform.machine=lambda:'arm64'\n")
        for package, version in [('mlx-embeddings', '0.0.5'), ('mlx', '0.31.1')]:
            path = self.modules / (package.replace('-', '_') + '-' + version + '.dist-info')
            path.mkdir()
            (path / 'METADATA').write_text(f'Name: {package}\nVersion: {version}\n')
        backend = self.modules / 'mlx_embeddings'
        backend.mkdir()
        (backend / '__init__.py').write_text('# synthetic backend bytes; no model imports\n')
        pip = self.modules / 'pip'
        pip.mkdir()
        (pip / '__init__.py').write_text('')
        (pip / '__main__.py').write_text("import json,os,sys\nwith open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps({'pip':sys.argv[1:], 'HTTP_PROXY':os.getenv('HTTP_PROXY'), 'HTTPS_PROXY':os.getenv('HTTPS_PROXY')})+'\\n')\n")
        hf = self.modules / 'huggingface_hub'
        hf.mkdir()
        (hf / '__init__.py').write_text('''
import json,os
from pathlib import Path
__version__='fixture'
def snapshot_download(repo_id, revision=None, local_files_only=False):
    previous=[json.loads(line) for line in Path(os.environ['FIXTURE_LOG']).read_text().splitlines()]
    with open(os.environ['FIXTURE_LOG'],'a') as f:
        f.write(json.dumps({'repo':repo_id,'revision':revision,'local_files_only':local_files_only,
            'HTTP_PROXY':os.getenv('HTTP_PROXY'),'HTTPS_PROXY':os.getenv('HTTPS_PROXY'),
            'timeout':os.getenv('HF_HUB_DOWNLOAD_TIMEOUT')})+'\\n')
    proxy=os.getenv('FIXTURE_REQUIRE_PROXY')
    if proxy and any(os.getenv(key)!=proxy for key in ['HTTP_PROXY','HTTPS_PROXY']):
        raise ConnectionError('Direct download disabled by fixture')
    attempts=sum('repo' in row for row in previous)
    if attempts<int(os.getenv('FIXTURE_DOWNLOAD_FAILURES','0')):
        raise TimeoutError('Controlled download failure')
    target=Path(os.environ['HF_HOME'])/(revision or 'latest')
    target.mkdir(exist_ok=True)
    for name,content in json.loads(Path(os.environ['FIXTURE_ARTIFACTS']).read_text()).items():
        (target/name).write_text(content if revision else 'upstream latest has moved')
    return str(target)
''')
        artifacts = {'config.json': json.dumps({'torch_dtype': 'bfloat16'}), 'tokenizer.json': 'synthetic tokenizer',
                     'tokenizer_config.json': 'synthetic tokenizer config', 'model.safetensors': 'synthetic weights'}
        self.artifacts = self.root / 'artifacts.json'
        self.artifacts.write_text(json.dumps(artifacts))
        self.deployment = json.loads(DEPLOYMENT.read_text())
        recipe = self.deployment['generations']['g1']['recipe']
        digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
        recipe.update(modelConfigSha256=digest(artifacts['config.json']), tokenizerSha256=digest(artifacts['tokenizer.json']),
                      tokenizerConfigSha256=digest(artifacts['tokenizer_config.json']), weightsSha256=digest(artifacts['model.safetensors']))
        entries = [['__init__.py', digest((backend / '__init__.py').read_text())]]
        recipe['backendCodeSha256'] = digest(json.dumps(entries, separators=(',', ':')))
        config_path = self.root / 'packages/api/runtime/services/embedding-generations.json'
        config_path.parent.mkdir(parents=True)
        config_path.write_text(json.dumps(self.deployment))
        self.venv = self.root / 'home/embed-venv'
        binaries = self.venv / 'bin'
        binaries.mkdir(parents=True)
        for name in ['python', 'python3']:
            path = binaries / name
            path.write_text('#!/bin/sh\nexec "$FIXTURE_PYTHON" "$@"\n')
            path.chmod(0o700)
        (binaries / 'activate').write_text('export PATH="$FIXTURE_BIN:$PATH"\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, content in {'uname': '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi\n',
                              'sysctl': '#!/bin/sh\necho 1\n',
                              'pip': '#!/bin/sh\nexec "$FIXTURE_PYTHON" -m pip "$@"\n'}.items():
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o700)
        self.env = {**os.environ, 'CAT_CAFE_HOME': str(self.venv.parent), 'EMBED_GENERATION': 'g1',
                    'EMBED_MODEL': recipe['modelId'], 'HF_HOME': str(self.cache), 'PYTHONPATH': str(self.modules),
                    'FIXTURE_ARTIFACTS': str(self.artifacts), 'FIXTURE_PYTHON': sys.executable,
                    'FIXTURE_LOG': str(self.log), 'FIXTURE_BIN': str(self.bin), 'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}
        for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', '_CATCAFE_HF_PROXY_FOR_DOWNLOAD',
                    'HF_HUB_DOWNLOAD_TIMEOUT']:
            self.env.pop(key, None)

    def run_install(self):
        return subprocess.run(['/bin/bash', str(self.scripts / 'embed-install.sh')], env=self.env, capture_output=True, text=True, timeout=20)

    def test_system_proxy_is_only_injected_into_exact_revision_download_not_pip(self):
        proxy = 'http://127.0.0.1:18999'
        self.env.update(_CATCAFE_HF_PROXY_FOR_DOWNLOAD=proxy, FIXTURE_REQUIRE_PROXY=proxy)
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [json.loads(line) for line in self.log.read_text().splitlines()]
        download = next(row for row in commands if 'repo' in row)
        self.assertEqual(download['revision'], self.deployment['generations']['g1']['recipe']['modelRevision'])
        self.assertEqual((download['HTTP_PROXY'], download['HTTPS_PROXY'], download['timeout']), (proxy, proxy, '60'))
        for row in commands:
            if 'pip' in row:
                self.assertEqual((row['HTTP_PROXY'], row['HTTPS_PROXY']), (None, None))

    def test_bounded_download_retries_and_diagnostics_are_preserved(self):
        with (self.modules / 'sitecustomize.py').open('a') as module:
            module.write("import json,os,time\ndef sleep(s):\n with open(os.environ['FIXTURE_LOG'],'a') as f:f.write(json.dumps({'retrySleepSeconds':s})+'\\n')\ntime.sleep=sleep\n")
        self.env['FIXTURE_DOWNLOAD_FAILURES'] = '2'
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(len([row for row in rows if 'repo' in row]), 3)
        self.assertEqual([row['retrySleepSeconds'] for row in rows if 'retrySleepSeconds' in row], [5, 10])
        self.assertIn('[hf-download diag]', result.stderr)
        self.log.unlink()
        self.env['FIXTURE_DOWNLOAD_FAILURES'] = '3'
        failure = self.run_install()
        self.assertNotEqual(failure.returncode, 0)
        self.assertNotIn('Installation complete.', failure.stdout)
        rows = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(len([row for row in rows if 'repo' in row]), 3)
        self.assertIn('Model download failed after 3 attempts', failure.stderr)

    def test_generation_preflight_uses_resolved_python_when_path_python_is_old_or_missing(self):
        # Exercise the real resolver; only the disk/network probes are replaced.
        for name in ['prereq-check.sh', 'python-resolve.sh']:
            shutil.copyfile(SOURCE / name, self.scripts / name)
        with (self.scripts / 'prereq-check.sh').open('a') as checks:
            checks.write('\ncheck_disk_space() { :; }\ncheck_network() { :; }\n')
        (self.bin / 'python3.13').symlink_to(sys.executable)
        path_python = self.bin / 'python3'
        path_python.write_text('#!/bin/sh\necho "PATH python3 is too old" >&2\nexit 97\n')
        path_python.chmod(0o700)
        old = self.run_install()
        self.assertEqual(old.returncode, 0, old.stderr)
        self.assertNotIn('PATH python3 is too old', old.stderr)
        self.assertIn(f'Python system: {self.bin / "python3.13"}', old.stdout)
        path_python.unlink()
        for name in ['dirname', 'grep']:
            (self.bin / name).symlink_to(shutil.which(name))
        self.env['PATH'] = str(self.bin)
        missing = self.run_install()
        self.assertEqual(missing.returncode, 0, missing.stderr)

    def test_empty_cache_installs_exact_revision_versions_and_verifies_before_success(self):
        self.assertEqual(list(self.cache.iterdir()), [])
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [json.loads(line) for line in self.log.read_text().splitlines()]
        packages = [arg for row in commands for arg in row.get('pip', [])]
        self.assertIn('mlx==0.31.1', packages)
        self.assertIn('mlx-embeddings==0.0.5', packages)
        downloads = [row for row in commands if 'repo' in row]
        self.assertEqual(len(downloads), 1)
        self.assertEqual(downloads[0]['revision'], self.deployment['generations']['g1']['recipe']['modelRevision'])
        self.assertFalse((self.cache / 'latest').exists())
        self.assertIn('verified representation', result.stdout)
        self.assertIn('Installation complete.', result.stdout)

    def test_moved_latest_is_not_reused_and_bad_backend_cannot_be_declared_installed(self):
        (self.cache / 'latest').mkdir()
        (self.cache / 'latest/config.json').write_text('unrelated upstream latest')
        successful = self.run_install()
        self.assertEqual(successful.returncode, 0, successful.stderr)
        backend = self.modules / 'mlx_embeddings/__init__.py'
        backend.write_text('# wrong backend bytes\n')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Installation complete.', result.stdout)

    def test_pinned_generation_is_explicitly_unsupported_before_install_on_other_platforms(self):
        # The check is shared by the shell and Windows wrapper and imports no model.
        (self.modules / 'sitecustomize.py').write_text("import platform\nplatform.system=lambda:'Windows'\nplatform.machine=lambda:'ARM64'\n")
        result = subprocess.run([sys.executable, str(self.scripts / 'embedding_generation_install.py'), '--generation', 'g1', '--check-platform'],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsupported', result.stderr.lower())
        self.assertFalse(self.log.exists())

    def test_legacy_generation_keeps_its_existing_compatible_installer(self):
        self.env['EMBED_GENERATION'] = 'g0'
        self.env['EMBED_MODEL'] = 'fixture/legacy'
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(any(row.get('repo') == 'fixture/legacy' and row['revision'] is None for row in commands))
        self.assertFalse(any(arg.startswith('mlx==') for row in commands for arg in row.get('pip', [])))
        self.assertIn('Installation complete.', result.stdout)


if __name__ == '__main__':
    unittest.main()
