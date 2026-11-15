"""Exercise the real startup wrapper with a CPU-only argv recorder, never a model."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent


class EmbedServerWrapper(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="embed-wrapper-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.scripts = self.root / "scripts/services"
        self.scripts.mkdir(parents=True)
        for name in ["embed-server.sh", "proxy-env.sh", "embedding_generation.py"]:
            shutil.copyfile(SOURCE / name, self.scripts / name)
        deployment = SOURCE.parents[1] / "packages/api/runtime/services/embedding-generations.json"
        target = self.root / "packages/api/runtime/services/embedding-generations.json"
        target.parent.mkdir(parents=True)
        shutil.copyfile(deployment, target)
        self.recipe_model = json.loads(target.read_text())["generations"]["g1"]["recipe"]["modelId"]
        self.capture = self.root / "argv.json"
        binaries = self.root / "home/embed-venv/bin"
        binaries.mkdir(parents=True)
        (binaries / "activate").write_text("export PATH=" + shlex.quote(str(binaries)) + ':"$PATH"\n')
        executable = binaries / "python3"
        executable.write_text(f"#!{sys.executable}\n" + '''
import json,os,sys
from pathlib import Path
if sys.argv[1].endswith('embedding_generation.py'):
    os.execv(sys.executable, [sys.executable, *sys.argv[1:]])
assert sys.argv[1].endswith('embed-api.py'), sys.argv
Path(os.environ['FIXTURE_CAPTURE']).write_text(json.dumps(sys.argv[1:]))
sys.exit(int(os.environ.get('FIXTURE_EXIT', '0')))
''')
        executable.chmod(0o700)
        self.env = {**os.environ, "CAT_CAFE_HOME": str(self.root / "home"),
                    "EMBED_MODEL": "fixture/legacy-model", "EMBED_PORT": "18980",
                    "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                    "FIXTURE_CAPTURE": str(self.capture)}
        self.env.pop("EMBED_GENERATION", None)
        self.env.pop("EMBED_MAX_MODEL_MEM_MB", None)

    def run_wrapper(self):
        return subprocess.run(["/bin/bash", str(self.scripts / "embed-server.sh")],
                              env=self.env, text=True, capture_output=True, timeout=15)

    def test_default_and_explicit_g0_without_optional_limit_reach_python(self):
        for generation in [None, "g0"]:
            if generation:
                self.env["EMBED_GENERATION"] = generation
            result = self.run_wrapper()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(self.capture.read_text())[1:],
                             ["--model", "fixture/legacy-model", "--port", "18980", "--generation", "g0"])

    def test_configured_limit_is_forwarded_for_both_generations(self):
        for generation, model, limit in [("g0", "fixture/legacy-model", "800"),
                                         ("g1", self.recipe_model, "12288")]:
            self.env.update(EMBED_GENERATION=generation, EMBED_MAX_MODEL_MEM_MB=limit)
            result = self.run_wrapper()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(self.capture.read_text())[1:],
                             ["--model", model, "--port", "18980", "--generation", generation,
                              "--max-model-mem-mb", limit])

    def test_child_exit_is_preserved_without_an_optional_limit(self):
        self.env.update(EMBED_GENERATION="g0", FIXTURE_EXIT="70")
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 70, result.stderr)
        self.assertIn("python exited with code 70", result.stdout)

    def test_missing_legacy_model_still_fails_before_child_launch(self):
        self.env.update(EMBED_GENERATION="g0", EMBED_MODEL="")
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("EMBED_MODEL env var required", result.stderr)
        self.assertFalse(self.capture.exists())


if __name__ == "__main__":
    unittest.main()
